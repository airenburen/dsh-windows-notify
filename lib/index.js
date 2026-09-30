/**
 * dsh-windows-notify —— DSH 宿主半边的 Windows 通知插件。
 *
 * 三件事：
 *  1. 监听会话的「需要你操作」状态（权限/批准请求、AI 提问），可选监听「一轮结束」
 *     与「会话出错」，弹一条 Windows 原生 Toast（WinRT，经 Windows PowerShell 5.1）。
 *  2. 点击通知回到 DSH：toast 用 protocol 激活，注册 `dsh-notify:`（HKCU）指向
 *     桌面端可执行文件——它持有单实例锁，二次启动即 restore + focus 已有窗口。
 *  3. 给 AI 一个写通知的 API：模型工具 `notify_user`，以及给任意脚本用的
 *     HTTP 接口 `POST /plugins/dsh-windows-notify/send`；同时把同一个能力挂成
 *     `ctx.windowsNotify` 服务供其它插件调用。
 *
 * @module dsh-windows-notify
 */

import { randomUUID } from 'node:crypto';

import z from '@deepseek-ai/schemastery';

import { defineTool } from './define-tool.js';

import {
  DEFAULT_AUMID,
  defaultIconPath,
  removeWindowsToast,
  showWindowsToast,
  toastAvailability,
} from './win-toast.js';
import {
  DEFAULT_SCHEME,
  detectLauncher,
  ensureDecisionProtocol,
  protocolCommandFor,
  resolveClickTarget,
} from './protocol.js';
import {
  dictionary,
  isPrivilegedApproval,
  oneLine,
  summarizeAgentNotification,
  summarizeApproval,
  summarizeError,
  summarizeQuestion,
  summarizeTurnEnd,
} from './messages.js';

/** loader entry 名（= profile patch 里的 row id，也是 settings 命名空间）。 */
export const name = 'windows-notify';
/** 本插件在 profile patch 里的 loader entry id；同时是 ctx.settings 的命名空间。 */
export const ENTRY_ID = 'windows-notify';

/**
 * 「DSH 在前台」的判定窗口：客户端半边每 ~15 秒心跳一次，超过这个时间没消息就
 * 当作后台（例如页面被关掉/崩溃/换了机器）。宁可多弹一条，也不要不弹。
 */
export const FOCUS_TTL_MS = 45000;

/**
 * 纯函数：从「各窗口上报的焦点状态」算出 DSH 现在是不是在前台。
 * @param {Map<string, {focused: boolean, at: number}> | Array<{focused: boolean, at: number}>} reports
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {boolean}
 */
export function isForegroundReport(reports, now, ttlMs = FOCUS_TTL_MS) {
  const list = reports instanceof Map ? [...reports.values()] : Array.from(reports ?? []);
  return list.some((entry) => entry?.focused === true && Number.isFinite(entry.at) && now - entry.at <= ttlMs);
}

/** 配置：全部标 volatile，插件在使用的当下读取，改设置立即生效且无需重载。 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  notifyApproval: z.boolean().default(true).volatile(),
  notifyQuestion: z.boolean().default(true).volatile(),
  notifyTurnEnd: z.boolean().default(false).volatile(),
  notifyError: z.boolean().default(true).volatile(),
  agentTool: z.boolean().default(true).volatile(),
  httpApi: z.boolean().default(true).volatile(),
  focusOnClick: z.boolean().default(true).volatile(),
  sound: z.boolean().default(true).volatile(),
  displaySeconds: z.number().min(0).max(3600).default(10).volatile(),
  sticky: z.boolean().default(false).volatile(),
  decisionButtons: z.boolean().default(true).volatile(),
  decisionSeconds: z.number().min(0).max(3600).default(300).volatile(),
  // 哪些审批在通知上带「允许 / 拒绝」按钮：safe-only（默认）= 高危的 danger-full-access
  // 不发按钮、必须去界面点；all = 所有审批都发。误点一下就能放行特权操作，默认从严。
  decisionButtonsFor: z.union([z.const('safe-only'), z.const('all')]).default('safe-only').volatile(),
  // DSH 窗口在前台时怎么办：silent（默认）= 只进操作中心、不弹横幅不响铃；
  // skip = 完全不发（历史仍记录）；notify = 照常弹。
  // 只作用于自动状态通知；notify_user / HTTP /send 这类显式通知照旧弹。
  whenFocused: z.union([z.const('silent'), z.const('skip'), z.const('notify')]).default('silent').volatile(),
  language: z.union([z.const('zh'), z.const('en')]).default('zh').volatile(),
  aumid: z.string().default(DEFAULT_AUMID).volatile(),
  dedupeMs: z.number().min(0).max(600000).default(4000).volatile(),
  maxPerMinute: z.number().min(0).max(600).default(20).volatile(),
  debugLog: z.boolean().default(false).volatile(),
});

/**
 * 读取一个配置字段的当前值：volatile 字段由 loaders 以稳定引用交进来，需要 `.get()`。
 * @param {unknown} field - 配置字段
 * @param {unknown} fallback - 缺省值
 */
function cfgValue(field, fallback) {
  if (field === undefined || field === null) return fallback;
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get();
    return value === undefined ? fallback : value;
  }
  return field;
}

/** 读取请求体（上限 64KB）。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

/** 请求是否来自本机回环（配置写入只允许本机）。 */
function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 安装插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {object} config - 已解析的配置（volatile 字段为引用）
 * @param {object} [deps] - 测试注入口（loader 只传两个参数）
 */
export function apply(ctx, config, deps = {}) {
  const sendToast = deps.showWindowsToast ?? showWindowsToast;
  const resolveTarget = deps.resolveClickTarget ?? resolveClickTarget;
  const launcherOf = deps.detectLauncher ?? detectLauncher;
  const availabilityOf = deps.toastAvailability ?? toastAvailability;
  const config0 = config ?? {};

  const read = (key, fallback) => cfgValue(config0[key], fallback);
  const log = (level, message) => {
    const logger = ctx.logger;
    if (level === 'warn') logger?.warn?.(`windows-notify: ${message}`);
    else if (level === 'error') logger?.error?.(`windows-notify: ${message}`);
    else if (read('debugLog', false)) logger?.info?.(`windows-notify: ${message}`);
  };

  const state = {
    /** 「点击通知回到 DSH」的目标 URI（惰性解析）。 */
    click: { status: 'pending' },
    /** 「允许 / 拒绝」按钮的回传通道状态（惰性注册）。 */
    decision: { status: 'pending' },
    /** 从真实请求上得知的宿主自身地址（按钮回传脚本要写它）。 */
    origin: undefined,
    /**
     * 各窗口上报的焦点状态：`windowId → { focused, at }`。
     * 判定见 `isForegroundReport`（带 TTL，心跳停了就当作后台）。
     */
    focus: new Map(),
    /** tag → 上次发送时间，用于去重（同一状态短时间内不重复弹）。 */
    recent: new Map(),
    /** 最近一分钟的发送时间戳，用于限流。 */
    sent: [],
    /** 最近发出的通知（新的在前，最多 50 条），供侧栏「通知」页展示。 */
    history: [],
    /** 待回传的按钮决定：token → { settle, timer, tag }。 */
    pending: new Map(),
    /**
     * 最近「从通知按钮结算掉」的审批（新的在前，最多 20 条）。客户端半边拉它，
     * 用来关掉 GUI 里那张还在等你自己点的审批卡；seq 单调递增，客户端按 since 增量取。
     */
    decisions: [],
    decisionSeq: 0,
    lastError: undefined,
  };

  /**
   * 注册按钮回传通道（隐藏 PowerShell → 本机回环 POST）。只有注册成功才敢发按钮，
   * 否则点下去系统会弹「选择打开方式」。
   *
   * 回传脚本里要写死宿主的 HTTP 地址，而 `webServer` 服务不暴露自己的监听地址、
   * 宿主进程里也没有 `DSH_WEB_URL`（那是注入给 shell 子进程的），所以地址由
   * `noteOrigin()` 从真实请求的 socket 上取到后再传进来。
   *
   * @param {string} [base] - 宿主自己的基地址（未给则退回 DSH_WEB_URL 环境变量）
   */
  async function ensureDecisionChannel(base) {
    if (read('decisionButtons', true) !== true) {
      state.decision = { status: 'failed', reason: 'disabled' };
      return state.decision;
    }
    const resolved = base ?? (typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL !== '' ? process.env.DSH_WEB_URL : undefined);
    if (resolved === undefined) {
      // 还不知道自己在哪个端口上：等第一个请求把地址带过来再注册（此刻先不发按钮）。
      state.decision = { status: 'failed', reason: 'no-web-url' };
      return state.decision;
    }
    if (state.decision.status === 'ready' && state.decision.base === resolved) return state.decision;
    if (state.decision.status === 'running' && state.decision.base === resolved) return await state.decision.promise;

    state.decision = { status: 'running', base: resolved };
    const promise = (async () => {
      try {
        const result = await (deps.ensureDecisionProtocol ?? ensureDecisionProtocol)({ scheme: DEFAULT_SCHEME, base: resolved });
        state.decision = { status: result.ok ? 'ready' : 'failed', base: resolved, ...result };
        log(
          result.ok ? 'info' : 'warn',
          result.ok
            ? `decision channel ready at ${resolved}${result.changed === true ? ' (registered)' : ''}`
            : `decision channel unavailable: ${result.reason}`,
        );
      } catch (error) {
        state.decision = { status: 'failed', base: resolved, reason: String(error?.message ?? error) };
        log('warn', `decision channel registration threw: ${state.decision.reason}`);
      }
      return state.decision;
    })();
    state.decision.promise = promise;
    return await promise;
  }

  /**
   * 从一条真实请求上记下宿主自己的回环地址：`socket.localPort` 是**服务端监听端口**，
   * 比 Host 头可靠（桌面端页面的请求是 Electron 主进程转发过来的）。
   * @param {import('node:http').IncomingMessage} req
   */
  function noteOrigin(req) {
    const port = Number(req?.socket?.localPort);
    if (!Number.isFinite(port) || port <= 0) return;
    const raw = String(req?.socket?.localAddress ?? '');
    const host = raw === '' || raw === '0.0.0.0' || raw === '::' || raw === '::1' ? '127.0.0.1' : raw;
    const base = `http://${host}:${port}`;
    state.origin = base;
    if (state.decision.status === 'ready' && state.decision.base === base) return;
    if (state.decision.status === 'running' && state.decision.base === base) return;
    void ensureDecisionChannel(base).catch(() => {});
  }

  /** DSH 现在是不是在前台（靠客户端半边的心跳，超时即当作后台）。 */
  function isForeground() {
    return isForegroundReport(state.focus, Date.now());
  }

  /** 记录一次客户端上报的焦点状态。 */
  function noteFocus(windowId, focused) {
    const id = typeof windowId === 'string' && windowId !== '' ? windowId.slice(0, 64) : 'default';
    state.focus.set(id, { focused: focused === true, at: Date.now() });
    // 只保留最近上报的若干窗口，避免长期运行下无限增长。
    if (state.focus.size > 8) {
      const oldest = [...state.focus.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest !== undefined) state.focus.delete(oldest[0]);
    }
    return { focused: focused === true, foreground: isForeground(), windows: state.focus.size };
  }

  /**
   * 挂一个待决定的 token。
   * @param {number} ttlSeconds - 按钮可点击窗口（也是 token 寿命）
   * @returns {{token: string, tag: string, promise: Promise<string>, cancel: Function}}
   */
  function offerDecision(ttlSeconds) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16);
    const tag = `ap-${token.slice(0, 8)}`;
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      state.pending.delete(token);
    }, Math.max(1, ttlSeconds) * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    state.pending.set(token, { settle, timer, tag });
    return {
      token,
      tag,
      promise,
      cancel: () => {
        clearTimeout(timer);
        state.pending.delete(token);
      },
    };
  }

  /**
   * 用一次按钮点击结算一个 token。
   * @param {string} token
   * @param {string} choice - `allow` | `reject`
   * @returns {string | undefined} 结算出的 ApprovalOutcome（token 不存在/过期时 undefined）
   */
  function answerDecision(token, choice) {
    const entry = state.pending.get(token);
    if (entry === undefined) return undefined;
    state.pending.delete(token);
    clearTimeout(entry.timer);
    const outcome = choice === 'reject' ? 'rejected' : 'allowed-once';
    entry.settle(outcome);
    return outcome;
  }

  /**
   * 解析「点击通知回到 DSH」的目标：桌面端优先直接用应用自己注册的 `dsh://open`
   * （Electron 的 second-instance 会把主窗口 restore + show + focus），
   * 否则注册本插件的协议兜底。结果缓存在 state.click。
   */
  async function ensureClickTarget() {
    if (state.click.status === 'ready') return state.click;
    if (state.click.status === 'running') return await state.click.promise;
    state.click = { status: 'running' };
    const promise = (async () => {
      try {
        const result = await resolveTarget({ scheme: DEFAULT_SCHEME, launcher: launcherOf() });
        state.click = { status: result.ok ? 'ready' : 'failed', ...result };
        log(
          result.ok ? 'info' : 'warn',
          result.ok
            ? `click target ${result.mode} → ${result.uri}${result.changed === true ? ' (registered)' : ''}`
            : `click target unavailable: ${result.reason}`,
        );
      } catch (error) {
        state.click = { status: 'failed', reason: String(error?.message ?? error), mode: 'none' };
        log('warn', `click target resolution threw: ${state.click.reason}`);
      }
      return state.click;
    })();
    state.click.promise = promise;
    return await promise;
  }

  /** 限流 + 去重判定。 */
  function admit(tag) {
    const now = Date.now();
    const dedupeMs = Number(read('dedupeMs', 4000)) || 0;
    const maxPerMinute = Number(read('maxPerMinute', 20)) || 0;
    if (tag !== undefined && dedupeMs > 0) {
      const last = state.recent.get(tag);
      if (last !== undefined && now - last < dedupeMs) return { ok: false, reason: 'duplicate' };
    }
    state.sent = state.sent.filter((time) => now - time < 60000);
    if (maxPerMinute > 0 && state.sent.length >= maxPerMinute) return { ok: false, reason: 'rate-limited' };
    if (tag !== undefined) state.recent.set(tag, now);
    state.sent.push(now);
    return { ok: true };
  }

  /**
   * 发一条通知。
   * @param {{title: string, body?: string, lines?: string[], tag?: string,
   *   silent?: boolean, sticky?: boolean, actionText?: string,
   *   source: string, force?: boolean, explicit?: boolean}} request
   */
  async function notify(request) {
    const availability = availabilityOf();
    if (!availability.available) {
      return { ok: false, skipped: availability.reason };
    }
    if (!request.force && !read('enabled', true)) {
      return { ok: false, skipped: 'disabled' };
    }
    // DSH 在前台时怎么处理：silent（默认）= 只进操作中心、不弹横幅；skip = 完全不发；
    // notify = 照常弹。AI/脚本的显式通知（notify_user、HTTP /send）不受此限制——
    // 那是「我就是要提醒你」，压掉反而奇怪。
    const whenFocused = read('whenFocused', 'silent');
    const foreground = isForeground();
    const focusedPolicy = request.explicit === true || whenFocused === 'notify' ? 'notify' : whenFocused;
    if (foreground && focusedPolicy === 'skip') {
      log('info', `skipped while DSH is in the foreground (${request.source})`);
      state.history.unshift({
        ts: Date.now(),
        title: request.title,
        body: request.body ?? '',
        tag: request.tag,
        source: request.source,
        ok: false,
        skipped: 'foreground',
      });
      if (state.history.length > 50) state.history.length = 50;
      return { ok: false, skipped: 'foreground' };
    }
    const suppressPopup = foreground && focusedPolicy === 'silent' && read('enabled', true) === true;
    const admitted = admit(request.tag);
    if (!admitted.ok) return { ok: false, skipped: admitted.reason };

    const focus = read('focusOnClick', true);
    const target = focus ? await ensureClickTarget() : undefined;
    const launch = target?.ok === true ? target.uri : undefined;

    // 显示时间限制：displaySeconds>0 时给 toast 设 ExpirationTime，到点自动离开屏幕与
    // 操作中心；=0 表示不限制（此时才允许「提醒」样式的常驻通知）。
    // 单条通知自带的 expiresInSeconds（例如带按钮的审批，窗口更长）优先于全局值。
    const limitSeconds = Number(read('displaySeconds', 10));
    const configuredLimit = Number.isFinite(limitSeconds) && limitSeconds > 0 ? limitSeconds : undefined;
    const expiresInSeconds = request.expiresInSeconds ?? configuredLimit;
    const wantSticky = request.sticky ?? request.stickyDefault ?? read('sticky', false);
    const sticky = wantSticky === true && expiresInSeconds === undefined;

    const lang = read('language', 'zh') === 'en' ? 'en' : 'zh';
    let result;
    try {
      result = await sendToast({
        title: request.title,
        body: request.body,
        lines: request.lines ?? [],
        tag: request.tag,
        group: 'dsh',
        silent: request.silent ?? !read('sound', true),
        sticky,
        expiresInSeconds,
        suppressPopup,
        actions: request.actions,
        actionText: request.actionText ?? dictionary(lang).agentToolTitle,
        launch,
        aumid: read('aumid', DEFAULT_AUMID),
        icon: deps.iconPath ?? defaultIconPath(),
      });
    } catch (error) {
      // 发送通道本身抛错（例如 powershell 起不来）也只降级，不向外抛。
      state.lastError = String(error?.message ?? error);
      log('warn', `toast threw (${request.source}): ${state.lastError}`);
      return { ok: false, error: state.lastError };
    }

    if (!result.ok) {
      state.lastError = result.error ?? result.skipped;
      log('warn', `toast failed (${request.source}): ${state.lastError}`);
    } else {
      log('info', `toast sent (${request.source})`);
    }
    // 记一条历史（不论成败都记，方便在侧栏「通知」页里排查）。
    state.history.unshift({
      ts: Date.now(),
      title: request.title,
      body: request.body ?? '',
      tag: request.tag,
      source: request.source,
      ok: result.ok === true,
      ...(suppressPopup ? { suppressed: 'foreground' } : {}),
      ...(result.ok === true ? {} : { error: result.error ?? result.skipped }),
    });
    if (state.history.length > 50) state.history.length = 50;
    return { ok: result.ok, skipped: result.skipped, error: result.error };
  }

  const lang = () => (read('language', 'zh') === 'en' ? 'en' : 'zh');

  /**
   * 发通知但绝不把异常抛回 DSH 的事件瀑布：通知失败只记日志。
   * 这里必须 catch，否则一个 rejected promise 会变成宿主进程的 unhandled rejection。
   */
  function fire(request) {
    notify(request).catch((error) => {
      state.lastError = String(error?.message ?? error);
      log('warn', `notify threw (${request.source}): ${state.lastError}`);
    });
  }

  /** 包一层 try/catch 的事件处理：事件监听里抛错会打断批准/提问流程。 */
  function guard(source, fn) {
    try {
      fn();
    } catch (error) {
      log('warn', `${source} handler threw: ${String(error?.message ?? error)}`);
    }
  }

  // ---- 会话状态 → 通知 ------------------------------------------------------

  ctx.on('approval/request', (request, next) => {
    // 无论按钮能不能用，后面的 answerer（GUI）都必须照常挂上，否则审批会被卡住。
    const composed = Promise.resolve().then(() => next());
    // 竞赛输掉的那条不要再冒泡成 unhandled rejection。
    composed.catch(() => {});

    if (!read('notifyApproval', true)) return composed;

    // 高危审批（danger-full-access）默认**不给按钮**：通知上的「允许」太容易误点，
    // 而误点的代价是不再受工作区限制。这类只提示去界面确认（decisionButtonsFor=all 可恢复）。
    const privileged = isPrivilegedApproval(request);
    const buttonsAllowedByRisk = read('decisionButtonsFor', 'safe-only') === 'all' || !privileged;
    const offersButtons = read('decisionButtons', true) === true
      && buttonsAllowedByRisk
      && state.decision.status === 'ready'
      && state.decision.ok === true;

    if (!offersButtons) {
      guard('approval', () => {
        // 只在「按钮是被风险规则拦下」时提示去界面；用户自己关掉按钮就不啰嗦了。
        const summary = summarizeApproval(request, lang(), {
          guiOnly: read('decisionButtons', true) === true && !buttonsAllowedByRisk,
        });
        fire({ ...summary, source: 'approval' });
      });
      return composed;
    }

    // 「只有允许 / 拒绝」的权限申请：做两个按钮，点哪一个都直接结算这次审批。
    const configured = Number(read('decisionSeconds', 300));
    const ttl = Number.isFinite(configured) && configured > 0 ? configured : undefined;
    const pending = offerDecision(ttl ?? Math.max(30, Number(read('displaySeconds', 10)) || 30));
    const summary = summarizeApproval(request, lang());
    const dict = dictionary(lang());
    let decidedByToast = false;
    pending.promise.then(() => {
      decidedByToast = true;
    });

    guard('approval', () => fire({
      ...summary,
      tag: pending.tag,
      source: 'approval',
      sticky: false,
      expiresInSeconds: ttl,
      actions: [
        { content: dict.allowAction, arguments: `${DEFAULT_SCHEME}:allow/${pending.token}`, style: 'Success' },
        { content: dict.rejectAction, arguments: `${DEFAULT_SCHEME}:reject/${pending.token}`, style: 'Critical' },
      ],
    }));

    return Promise.race([composed, pending.promise]).then((outcome) => {
      pending.cancel();
      // 无论谁先回答，都把这条带按钮的通知撤掉（按钮已失效），并留一条记录。
      void (deps.removeWindowsToast ?? removeWindowsToast)({
        tag: pending.tag,
        group: 'dsh',
        aumid: read('aumid', DEFAULT_AUMID),
      }).catch(() => {});
      if (decidedByToast) {
        state.history.unshift({
          ts: Date.now(),
          title: outcome === 'rejected' ? dict.rejectedFromToast : dict.allowedFromToast,
          body: summary.title,
          tag: pending.tag,
          source: 'decision',
          ok: true,
        });
        if (state.history.length > 50) state.history.length = 50;
        // 记一条「已从通知结算」的事实：客户端半边靠它关掉 GUI 里那张还挂着的审批卡
        // （GUI 的卡片只由它自己那个 pending 实例结束才消失，宿主这边的答案它看不到）。
        state.decisionSeq += 1;
        const sessionId = request?.agent?.id;
        state.decisions.unshift({
          seq: state.decisionSeq,
          ts: Date.now(),
          outcome,
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
          ...(request?.callId === undefined ? {} : { callId: String(request.callId) }),
          ...(typeof request?.toolName === 'string' ? { toolName: request.toolName } : {}),
        });
        if (state.decisions.length > 20) state.decisions.length = 20;
        log('info', `approval decided from the toast: ${String(outcome)}`);
        // 观测用：客户端半边把卡片收掉时，GUI 那条链会迟到地回一个答案——
        // 日志里能看到这一行，就说明清卡动作真的发生了（debugLog=true 时可见）。
        composed.then(
          (late) => log('info', `GUI chain answered after the toast decision: ${String(late)}`),
          () => {},
        ).catch(() => {});
      }
      return outcome;
    });
  });

  ctx.on('user-questions/request', (request, next) => {
    if (read('notifyQuestion', true)) {
      guard('question', () => {
        const summary = summarizeQuestion(request, lang());
        fire({ ...summary, source: 'user-question' });
      });
    }
    return next();
  });

  ctx.on('agent/turn-stopping', (payload) => {
    if (!read('notifyTurnEnd', false)) return;
    guard('turn-end', () => {
      const summary = summarizeTurnEnd(payload, lang());
      fire({ ...summary, sticky: false, source: 'turn-end' });
    });
  });

  ctx.on('agent/error', (payload) => {
    if (!read('notifyError', true)) return;
    guard('agent-error', () => {
      const summary = summarizeError(payload, lang());
      fire({ ...summary, sticky: false, source: 'agent-error' });
    });
  });

  // ---- AI 可调用的 API ------------------------------------------------------

  /** 供 AI / HTTP / 其它插件共用的发送入口。 */
  const api = {
    /**
     * @param {{title: string, message?: string, body?: string, tag?: string,
     *   silent?: boolean, sticky?: boolean}} args
     * @returns {Promise<{ok: boolean, delivered: boolean, title: string, body: string,
     *   skipped?: string, error?: string}>}
     */
    async send(args = {}) {
      const summary = summarizeAgentNotification(args, lang());
      const result = await notify({
        title: summary.title,
        body: summary.body,
        tag: args.tag ?? summary.tag,
        silent: args.silent,
        sticky: args.sticky ?? false,
        actionText: summary.actionText,
        source: 'api',
        force: true,
        // 显式通知（AI 的 notify_user、HTTP /send、其它插件调 ctx.windowsNotify）：
        // 「我就是要提醒你」，前台也照常弹横幅，不受 whenFocused 限制。
        explicit: true,
      });
      // 只回带已定义的字段：工具结果必须是 lossless JSON，undefined 会被注册表拒绝。
      return {
        ok: result.ok === true,
        delivered: result.ok === true,
        title: summary.title,
        body: summary.body,
        ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    /** 当前插件状态，供排查用。 */
    async status() {
      const availability = availabilityOf();
      return {
        platform: process.platform,
        available: availability.available,
        unavailableReason: availability.available ? undefined : availability.reason,
        aumid: read('aumid', DEFAULT_AUMID),
        language: lang(),
        enabled: read('enabled', true),
        displaySeconds: Number(read('displaySeconds', 10)),
        sticky: read('sticky', false),
        launcher: launcherOf(),
        click: state.click.status === 'ready' || state.click.status === 'failed'
          ? state.click
          : await ensureClickTarget(),
        decision: {
          status: state.decision.status,
          ok: state.decision.ok,
          mode: state.decision.status === 'ready' ? 'buttons' : undefined,
          reason: state.decision.reason,
          pending: state.pending.size,
          seconds: Number(read('decisionSeconds', 300)),
          buttonsFor: read('decisionButtonsFor', 'safe-only'),
        },
        // 前后台判定（客户端心跳 + TTL），设置卡片与排错都看它。
        focus: {
          foreground: isForeground(),
          policy: read('whenFocused', 'silent'),
          windows: state.focus.size,
          agesMs: [...state.focus.values()].map((entry) => Date.now() - entry.at),
          ttlMs: FOCUS_TTL_MS,
        },
        sent: state.history.length,
        lastError: state.lastError,
      };
    },
    /** 最近发出的通知（新的在前）。 */
    recent: (limit = 20) => state.history.slice(0, Math.max(0, Math.min(50, limit))),
    scheme: DEFAULT_SCHEME,
  };

  try {
    ctx.set('windowsNotify', api);
  } catch (error) {
    log('warn', `could not publish ctx.windowsNotify: ${String(error?.message ?? error)}`);
  }

  // 模型工具：AI 自己写一条通知。
  // 用 ctx.inject 而不是 ctx.get：工具注册表可能在插件激活之后才出现
  // （DSH 启动时不少插件都先处于「等待服务」状态）。
  if (read('agentTool', true)) {
    ctx.inject(['tools'], (sctx) => {
      try {
        const definition = defineTool({
          name: 'notify_user',
          description:
            '给用户发一条 Windows 系统通知（显示在屏幕右下角/操作中心，点击回到 DSH）。当你有需要用户知道、但不必打断当前对话的信息时使用；需要用户授权或回答问题的场合不要用它代替提问。',
          parameters: {
            title: { type: 'string', required: true, description: '通知标题，一行，尽量短。' },
            message: { type: 'string', required: true, description: '通知正文，一到两句话。' },
            tag: {
              type: 'string',
              description: '同 tag 的通知会互相替换（最多 16 字符），例如用同一个 tag 更新同一个任务的进度。',
            },
            silent: { type: 'boolean', description: 'true 时不出提示音。' },
            sticky: { type: 'boolean', description: 'true 时通知常驻直到用户手动关闭，用于重要提醒。' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true, description: '是否成功发送。' },
                delivered: { type: 'boolean', required: true, description: '通知是否已经交给系统。' },
                title: { type: 'string', required: true },
                body: { type: 'string', required: true },
                skipped: { type: 'string', description: '未发送的原因（disabled / duplicate / rate-limited / not-windows 等）。' },
                error: { type: 'string', description: '发送失败时的错误文本。' },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: value.delivered
                ? `已发送 Windows 通知：${value.title}`
                : `通知未发送${value.skipped !== undefined ? `（${value.skipped}）` : ''}${value.error !== undefined ? `：${value.error}` : ''}`,
            }],
          },
          async execute(args) {
            return await api.send({
              title: args.title,
              message: args.message,
              tag: args.tag,
              silent: args.silent,
              sticky: args.sticky,
            });
          },
        });
        sctx.effect(() => sctx.tools.register(definition));
      } catch (error) {
        log('warn', `notify_user tool not registered: ${String(error?.message ?? error)}`);
      }
    });
  }

  // HTTP API：任何脚本/AI 都能用。
  if (read('httpApi', true)) {
    ctx.inject(['webServer'], (sctx) => {
      /**
       * 注册一条路由：所有请求都先经过 noteOrigin —— 宿主自己的监听地址只能从
       * 真实请求上取到，而按钮回传脚本需要它。
       */
      const route = (path, handler) => sctx.effect(() => sctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          noteOrigin(req);
          await handler(req, res);
        },
      }));

      try {
        route('/plugins/dsh-windows-notify/send', async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          try {
            const payload = await readJsonBody(req);
            if (typeof payload.title !== 'string' || payload.title.trim() === '') {
              sendJson(res, 400, { ok: false, error: 'title is required' });
              return;
            }
            const result = await api.send(payload);
            sendJson(res, result.delivered ? 200 : 503, result);
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        });

        // 客户端半边在页面加载时 ping 一下：让宿主尽早知道自己的地址，
        // 这样第一条审批通知就带得上按钮。顺手把通道建好再回答，结果就是确定的。
        route('/plugins/dsh-windows-notify/hello', async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          if (state.origin !== undefined && state.decision.status !== 'ready') {
            await ensureDecisionChannel(state.origin);
          }
          sendJson(res, 200, { ok: true, origin: state.origin, decision: state.decision.status });
        });

        route('/plugins/dsh-windows-notify/status', async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          try {
            sendJson(res, 200, { ok: true, ...(await api.status()) });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        });

        route('/plugins/dsh-windows-notify/recent', async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          try {
            const limitRaw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'));
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 20;
            sendJson(res, 200, { ok: true, items: state.history.slice(0, limit) });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        });

        // 客户端半边拉这个增量：seq 单调递增，只回 since 之后的条目。
        route('/plugins/dsh-windows-notify/decisions', async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          try {
            const sinceRaw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since'));
            const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
            sendJson(res, 200, {
              ok: true,
              seq: state.decisionSeq,
              items: state.decisions.filter((decision) => decision.seq > since),
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        });

        // 客户端半边上报「DSH 窗口是不是在前台」：宿主是独立 Node 进程，拿不到
        // Electron 的窗口状态，只能由渲染进程告诉我们。带 TTL：心跳停了算后台。
        route('/plugins/dsh-windows-notify/focus', async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, foreground: isForeground(), windows: state.focus.size, ttlMs: FOCUS_TTL_MS });
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
              res.end();
              return;
            }
            if (!isLoopbackRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'loopback requests only' });
              return;
            }
            const body = await readJsonBody(req);
            const result = noteFocus(body.windowId, body.focused === true);
            sendJson(res, 200, { ok: true, ...result, ttlMs: FOCUS_TTL_MS });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        });

        // 通知里「允许 / 拒绝」按钮的回传口：由 %LOCALAPPDATA% 下那个隐藏 PowerShell
        // 脚本 POST 过来，token 是一次性的随机值，且只接受本机回环请求。
        route('/plugins/dsh-windows-notify/decision', async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'loopback requests only' });
            return;
          }
          try {
            const url = new URL(req.url ?? '/', 'http://x');
            const token = url.searchParams.get('token') ?? '';
            const choice = url.searchParams.get('choice') ?? '';
            if (choice !== 'allow' && choice !== 'reject') {
              sendJson(res, 400, { ok: false, error: 'choice must be allow or reject' });
              return;
            }
            const outcome = answerDecision(token, choice);
            if (outcome === undefined) {
              sendJson(res, 404, { ok: false, error: 'unknown or expired token' });
              return;
            }
            sendJson(res, 200, { ok: true, choice, outcome });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        });
      } catch (error) {
        log('warn', `http routes not registered: ${String(error?.message ?? error)}`);
      }
    });
  }

  // 设置页用的配置桥：读写本 entry 的 Config，走 DSH 自己的 settings 服务
  // （和「设置」层同一个落盘位置）。客户端半边 lib/client.js 的页面只跟这两个
  // 路由打交道，因此不依赖任何私有客户端 API。
  ctx.inject(['webServer', 'settings'], (sctx) => {
    const describeSelf = () => {
      try {
        return sctx.settings.describe({ redactSecrets: true }).find((d) => String(d.ns) === ENTRY_ID);
      } catch (error) {
        log('warn', `settings.describe failed: ${String(error?.message ?? error)}`);
        return undefined;
      }
    };

    try {
      sctx.effect(() => sctx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-windows-notify/config',
        handler: async (req, res) => {
          noteOrigin(req);
          try {
            if (req.method === 'GET') {
              const descriptor = describeSelf();
              if (descriptor === undefined) {
                sendJson(res, 404, { ok: false, error: `settings namespace "${ENTRY_ID}" not found` });
                return;
              }
              sendJson(res, 200, { ok: true, ns: ENTRY_ID, value: descriptor.value, revision: descriptor.revision });
              return;
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
              res.end();
              return;
            }
            if (!isLoopbackRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'loopback requests only' });
              return;
            }
            const body = await readJsonBody(req);
            const ops = Array.isArray(body.ops) ? body.ops : [];
            if (ops.length === 0) {
              sendJson(res, 400, { ok: false, error: 'ops is required' });
              return;
            }
            const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined;
            await sctx.settings.mutate(ENTRY_ID, ops, expected);
            const descriptor = describeSelf();
            sendJson(res, 200, { ok: true, ns: ENTRY_ID, value: descriptor?.value, revision: descriptor?.revision });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }));
    } catch (error) {
      log('warn', `config bridge not registered: ${String(error?.message ?? error)}`);
    }
  });

  // 启动即把「点击回到 DSH」的目标解析/注册好（异步、失败只警告），
  // 这样第一条通知点下去就已经能回到 DSH。
  if (read('focusOnClick', true) && availabilityOf().available) void ensureClickTarget().catch(() => {});
  // 按钮回传通道：宿主地址要靠第一个请求带过来（见 noteOrigin），所以这里只是
  // 「有环境变量就先用上」，拿不到就等客户端半边启动时 ping 一次再注册。
  if (read('decisionButtons', true) && availabilityOf().available) void ensureDecisionChannel().catch(() => {});

  log('info', `ready (available=${String(availabilityOf().available)}, aumid=${String(read('aumid', DEFAULT_AUMID))})`);
}

export { protocolCommandFor };
