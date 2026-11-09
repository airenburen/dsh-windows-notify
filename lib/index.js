/**
 * dsh-windows-notify —— DSH 宿主半边的 Windows 通知插件（编排层）。
 *
 * 三件事：
 *  1. 监听会话的「需要你操作」状态（权限/批准请求、AI 提问），可选监听「一轮结束」
 *     与「会话出错」，弹一条 Windows 原生 Toast（WinRT，经 Windows PowerShell 5.1）
 *     —— 事件注册在 lib/events.js；
 *  2. 点击通知回到 DSH + 审批按钮回传通道 —— 惰性注册在 lib/channels.js；
 *  3. 给 AI 一个写通知的 API：模型工具 `notify_user`，以及给任意脚本用的
 *     HTTP 接口（lib/http-routes.js）；同时把同一个能力挂成 `ctx.windowsNotify`
 *     服务供其它插件调用。
 *
 * 本文件只保留：Config、notify 主路径（去重/限流/前后台/显示时限）、
 * PowerShell 发送通道、状态组装与各模块的接线。
 *
 * @module dsh-windows-notify
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  protocolCommandFor,
} from './protocol.js';
import { createChannels, createDecisionTokens } from './channels.js';
import { registerEvents } from './events.js';
import { registerRoutes } from './http-routes.js';
import {
  dictionary,
  isPrivilegedApproval,
  oneLine,
  summarizeAgentNotification,
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
 * 「从通知按钮结算」事实的落盘路径（存活于 %LOCALAPPDATA%，与按钮回传脚本同目录）。
 * 落盘只为了宿主重启后 seq 不回退——客户端半边的 since 基线依赖单调 seq，
 * 回退会让它把旧事实当新的（对已消失的卡片是无害 no-op，但日志会很吵）。
 */
export function decisionLedgerPath(home = process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.') {
  return join(home, 'dsh-windows-notify', 'decisions.json');
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
  // 哪些审批在通知上带「允许 / 拒绝」按钮：safe-only（默认）= 高危的
  // 不发按钮、必须去界面点；all = 所有审批都发。误点一下就能放行特权操作，默认从严。
  decisionButtonsFor: z.union([z.const('safe-only'), z.const('all')]).default('safe-only').volatile(),
  // 哪些权限模式算「高危」（不给通知按钮，只提示去界面确认）。默认只有
  // danger-full-access；如果 DSH 未来引入新的特权档位，把它的名字加进这个列表。
  // 判定只认权限模式本身（结构化字段），理由文本不再参与——文本匹配会漏判。
  privilegedModes: z.array(z.string()).default(['danger-full-access']).volatile(),
  // 通知过滤：只对匹配的会话弹状态通知（审批/提问/回合结束/出错）。
  // undefined / 空 = 不过滤（全部弹）。匹配对象是会话标题或 cwd 末段，
  // 大小写不敏感的包含匹配；示例 ['dsh-windows-notify', '猫窝']。
  sessionFilter: z.array(z.string()).default([]).volatile(),
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

/**
 * 纯函数：会话是否通过 sessionFilter 过滤。
 * @param {string[]} patterns - 配置的过滤词（空 = 不过滤）
 * @param {object} agent - 事件载荷里的 agent（含 session 标题/cwd）
 * @returns {boolean} true = 通过（应弹通知）
 */
export function sessionAllowed(patterns, agent) {
  const list = Array.isArray(patterns) ? patterns.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  if (list.length === 0) return true;
  const session = agent?.session;
  const candidates = [];
  const title = session?.header?.title ?? session?.title ?? session?.header?.summary;
  if (typeof title === 'string') candidates.push(title);
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string') {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    candidates.push(cwd, parts[parts.length - 1] ?? cwd);
  }
  const id = agent?.id;
  if (typeof id === 'string') candidates.push(id);
  const haystack = candidates.join('\n').toLowerCase();
  if (haystack === '') return false; // 配了过滤但识别不出会话 → 宁可不弹（用户明确要求收窄）
  return list.some((pattern) => haystack.includes(pattern.toLowerCase()));
}

/**
 * 安装插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {object} config - 已解析的配置（volatile 字段为引用）
 * @param {object} [deps] - 测试注入口（loader 只传两个参数）
 */
export function apply(ctx, config, deps = {}) {
  const sendToast = deps.showWindowsToast ?? showWindowsToast;
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
    /** 从真实请求上得知的宿主自身地址（按钮回传脚本要写它）。 */
    origin: undefined,
    /**
     * 各窗口上报的焦点状态：`windowId → { focused, at }`。
     * 判定见 `isForegroundReport`（带 TTL，心跳停了就当作后台）。
     */
    focus: new Map(),
    focusTtlMs: FOCUS_TTL_MS,
    /** tag → 上次发送时间，用于去重（同一状态短时间内不重复弹）。 */
    recent: new Map(),
    /** 最近一分钟的发送时间戳，用于限流。 */
    sent: [],
    /** 最近发出的通知（新的在前，最多 50 条），供侧栏「通知」页展示。 */
    history: [],
    /**
     * 最近「从通知按钮结算掉」的审批（新的在前，最多 20 条）。客户端半边拉它，
     * 用来关掉 GUI 里那张还在等你自己点的审批卡；seq 单调递增（跨重启不回退，
     * 见 decisionLedger），客户端按 since 增量取。
     */
    decisions: [],
    decisionSeq: 0,
    lastError: undefined,
    /** 客户端半边上报的「审批卡清理」健康状态（#16；页面加载/清理失败时更新）。 */
    cardCleanup: { status: 'unknown' },
  };

  // ---- 通道与按钮 token（lib/channels.js）------------------------------------
  const channels = createChannels({
    ensureDecisionProtocol: deps.ensureDecisionProtocol ?? (async (options) => {
      const { ensureDecisionProtocol } = await import('./protocol.js');
      return await ensureDecisionProtocol(options);
    }),
    resolveClickTarget: deps.resolveClickTarget ?? (async (options) => {
      const { resolveClickTarget } = await import('./protocol.js');
      return await resolveClickTarget(options);
    }),
    detectLauncher: launcherOf,
    log,
  });

  const tokens = createDecisionTokens();

  // ---- 前后台（客户端心跳 + TTL）----------------------------------------------
  const isForeground = () => isForegroundReport(state.focus, Date.now());

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
    const decision = channels.state.decision;
    if (decision.status === 'ready' && decision.base === base) return;
    if (decision.status === 'running' && decision.base === base) return;
    void channels.ensureDecisionChannel(base).catch(() => {});
  }

  // ---- decisions 落盘（宿主重启后 seq 不回退）--------------------------------
  const ledger = createDecisionLedger({ read, log });
  state.decisionSeq = ledger.load().seq;
  state.decisions = ledger.load().items;

  /** 记一条「已从通知按钮结算」的事实：写内存增量 + 落盘。 */
  function recordDecisionFact(fact) {
    state.decisionSeq += 1;
    state.decisions.unshift({ seq: state.decisionSeq, ts: Date.now(), ...fact });
    if (state.decisions.length > 20) state.decisions.length = 20;
    ledger.save(state.decisionSeq, state.decisions);
  }

  // ---- PowerShell 发送通道（#9：长驻 worker，失败自动回退逐条 spawn）-----------
  // 优先级：deps.powerShellWorker（测试注入口）> deps.showWindowsToast（旧版注入口，
  // 保持向后兼容）> 长驻 worker（不可用/失败自动回退逐条 spawn）。
  const ps = deps.powerShellWorker ?? (deps.showWindowsToast === undefined
    ? createPowerShellWorker({ log })
    : null);
  const sendViaChannel = deps.showWindowsToast
    ? deps.showWindowsToast
    : async (options) => await ps.send(options);
  const removeViaChannel = deps.removeWindowsToast ?? (async (target) => await ps.remove(target));

  // ---- notify 主路径 ----------------------------------------------------------

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

  /** 把一条通知记进历史（新的在前，最多 50 条）。 */
  function pushHistory(record) {
    state.history.unshift(record);
    if (state.history.length > 50) state.history.length = 50;
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
      pushHistory({
        ts: Date.now(),
        title: request.title,
        body: request.body ?? '',
        tag: request.tag,
        source: request.source,
        ok: false,
        skipped: 'foreground',
      });
      return { ok: false, skipped: 'foreground' };
    }
    const suppressPopup = foreground && focusedPolicy === 'silent';
    const admitted = admit(request.tag);
    if (!admitted.ok) return { ok: false, skipped: admitted.reason };

    const focus = read('focusOnClick', true);
    const target = focus ? await channels.ensureClickTarget() : undefined;
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
      result = await sendViaChannel({
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
    pushHistory({
      ts: Date.now(),
      title: request.title,
      body: request.body ?? '',
      tag: request.tag,
      source: request.source,
      ok: result.ok === true,
      ...(suppressPopup ? { suppressed: 'foreground' } : {}),
      ...(result.ok === true ? {} : { error: result.error ?? result.skipped }),
    });
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

  // ---- 状态通知的会话过滤（sessionFilter，#13）--------------------------------
  // 包一层：事件模块发的是状态通知，统一在这里决定「这个会话要不要弹」。
  // 显式通知（notify_user / HTTP /send / 服务调用）与按钮结算留痕不过滤——那是点名提醒。
  const rawFire = fire;
  const filteredFire = (request) => {
    if (request.source === 'api' || request.source === 'decision') {
      rawFire(request);
      return;
    }
    if (sessionAllowed(read('sessionFilter', []), request.agent)) rawFire(request);
    else log('info', `session filtered out (${request.source})`);
  };

  // ---- 会话状态 → 通知（lib/events.js）----------------------------------------

  registerEvents(ctx, {
    read,
    fire: filteredFire,
    lang,
    tokens,
    decisionChannel: () => channels.state.decision,
    removeToast: removeViaChannel,
    log,
    // 审批结算后的历史留痕 + /decisions 增量：只有「从通知按钮结算」才产生事实
    // （GUI 先答的那次由卡片自己的结束流程收尾，客户端不需要也不能去点新卡片）。
    recordDecision: ({ request, outcome, decidedByToast, summary, tag }) => {
      if (decidedByToast) {
        const dict = dictionary(lang());
        pushHistory({
          ts: Date.now(),
          title: outcome === 'rejected' ? dict.rejectedFromToast : dict.allowedFromToast,
          body: summary.title,
          tag,
          source: 'decision',
          ok: true,
        });
        const sessionId = request?.agent?.id;
        recordDecisionFact({
          outcome,
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
          ...(request?.callId === undefined ? {} : { callId: String(request.callId) }),
          ...(typeof request?.toolName === 'string' ? { toolName: request.toolName } : {}),
        });
      }
    },
  }, removeWindowsToast);

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
        sticky: args.sticky,
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
      const click = channels.state.click;
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
        click: click.status === 'ready' || click.status === 'failed'
          ? click
          : await channels.ensureClickTarget(),
        decision: {
          status: channels.state.decision.status,
          ok: channels.state.decision.ok,
          mode: channels.state.decision.status === 'ready' ? 'buttons' : undefined,
          reason: channels.state.decision.reason,
          retryInMs: channels.state.decision.status === 'failed' && typeof channels.state.decision.at === 'number'
            ? Math.max(0, 60000 - (Date.now() - channels.state.decision.at))
            : undefined,
          pending: tokens.pending.size,
          seconds: Number(read('decisionSeconds', 300)),
          buttonsFor: read('decisionButtonsFor', 'safe-only'),
        },
        // 审批卡清理（客户端半边）上次尝试的结果：degraded = 卡片可能关不掉，
        // 排错时先看这里，而不是等「两分钟后没消失」。
        cardCleanup: state.cardCleanup,
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
    /** 清空通知历史（侧栏「通知」页的清除按钮）。 */
    clearHistory: () => {
      state.history.length = 0;
    },
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

  // 设置页用的配置桥（/config 路由需要 settings 服务）。
  // settingsBridge 是引用容器：webServer 先到时路由先注册，settings 服务后到时补上
  // describe/mutate（config 路由在补齐前被调用会得到明确的 503）。
  const settingsBridge = {
    describe: undefined,
    mutate: undefined,
  };

  // HTTP API：任何脚本/AI 都能用（lib/http-routes.js，统一回环 + Origin 安全门）。
  if (read('httpApi', true)) {
    ctx.inject(['webServer'], (sctx) => {
      try {
        registerRoutes(sctx, {
          api,
          state: {
            origin: () => state.origin,
            history: state.history,
            decisions: state.decisions,
            get decisionSeq() { return state.decisionSeq; },
            focus: state.focus,
            focusTtlMs: FOCUS_TTL_MS,
            foreground: isForeground,
            decisionChannel: () => channels.state.decision,
          },
          answerDecision: tokens.answer,
          noteFocus,
          noteOrigin,
          ensureDecisionChannel: channels.ensureDecisionChannel,
          settingsBridge: settingsBridge,
          entryId: ENTRY_ID,
          log,
        });
      } catch (error) {
        log('warn', `http routes not registered: ${String(error?.message ?? error)}`);
      }
    });
  }

  ctx.inject(['webServer', 'settings'], (sctx) => {
    const describeSelf = () => {
      try {
        return sctx.settings.describe({ redactSecrets: true }).find((d) => String(d.ns) === ENTRY_ID);
      } catch (error) {
        log('warn', `settings.describe failed: ${String(error?.message ?? error)}`);
        return undefined;
      }
    };
    settingsBridge.describe = describeSelf;
    settingsBridge.mutate = (ns, ops, expected) => sctx.settings.mutate(ns, ops, expected);
  });

  // 启动即把「点击回到 DSH」的目标解析/注册好（异步、失败只警告），
  // 这样第一条通知点下去就已经能回到 DSH。
  if (read('focusOnClick', true) && availabilityOf().available) void channels.ensureClickTarget().catch(() => {});
  // 按钮回传通道：宿主地址要靠第一个请求带过来（见 noteOrigin），所以这里只是
  // 「有环境变量就先用上」，拿不到就等客户端半边启动时 ping 一次再注册。
  if (read('decisionButtons', true) !== true) {
    channels.state.decision = { status: 'failed', reason: 'disabled' };
  } else if (availabilityOf().available) {
    void channels.ensureDecisionChannel().catch(() => {});
  }

  log('info', `ready (available=${String(availabilityOf().available)}, aumid=${String(read('aumid', DEFAULT_AUMID))})`);
}


/**
 * 「从通知按钮结算」事实的落盘账本（#10）：宿主重启后 seq 不回退、最近事实可恢复。
 * 文件与按钮回传脚本同目录（%LOCALAPPDATA%\\dsh-windows-notify\\decisions.json），
 * 损坏/不可写时静默退化为纯内存（重启后 seq 归零——与旧版行为一致，客户端 since
 * 基线会重新对齐，无害）。
 *
 * @param {{read: Function, log: Function}} io
 */
function createDecisionLedger({ read, log }) {
  let loaded;
  return {
    /** 读账本（惰性、只读一次盘）。 */
    load() {
      if (loaded !== undefined) return loaded;
      loaded = { seq: 0, items: [] };
      try {
        const path = decisionLedgerPath();
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw !== null && typeof raw === 'object'
          && Number.isFinite(raw.seq) && raw.seq > 0
          && Array.isArray(raw.items)) {
          loaded = { seq: Math.floor(raw.seq), items: raw.items.slice(0, 20) };
        }
      } catch (error) {
        if (read('debugLog', false)) log('info', `decision ledger not loaded: ${String(error?.message ?? error)}`);
      }
      return loaded;
    },
    /** 写账本（尽力而为：失败只记调试日志，绝不影响通知路径）。 */
    save(seq, items) {
      try {
        const path = decisionLedgerPath();
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({ seq, items }, null, 2), 'utf8');
      } catch (error) {
        log('warn', `decision ledger save failed: ${String(error?.message ?? error)}`);
      }
    },
  };
}

/**
 * PowerShell 发送通道（#9）：一个长驻的 Windows PowerShell 5.1 进程，通过 stdin
 * 按行收任务（每行一段 base64 的任务描述）、stdout 按行回结果。每条通知不再各自
 * 冷启动一个 powershell.exe（冷启动几百 ms，notifyTurnEnd 开着时延迟可感知）。
 *
 * 可靠性设计：
 *  - worker 未就绪/已死/单条失败 → 自动退回「逐条 spawn」老路径（与旧版完全一致）；
 *  - spawn 路径连续失败 3 次不再重试拉起 worker（直到进程重启），避免死循环拉起；
 *  - 进程退出（宿主关闭）时 worker 一并结束（stdin 关闭即退出）。
 *
 * worker 脚本本体见 tools/ps-worker.ps1（与插件一起分发）；这里只负责拉起与通信。
 *
 * @param {{log: Function, spawnScript?: Function}} io - spawnScript 测试注入口
 */
function createPowerShellWorker({ log, spawnScript }) {
  // deps.runPowerShellScript 未注入时用真实 spawn（动态 import 避免测试环境拉起真进程）。
  const realSpawn = spawnScript ?? (async (script, timeoutMs) => {
    const { runPowerShell } = await import('./win-toast.js');
    return await runPowerShell(script, timeoutMs);
  });

  let child = null;
  let starting = false;
  let buffer = '';
  let nextId = 1;
  /** id → { resolve }。 */
  const inflight = new Map();
  let failures = 0;
  /** false 后不再尝试拉起 worker（本轮进程生命周期内）。 */
  let workerAllowed = true;
  const WORKER_MAX_FAILURES = 3;

  function killWorker(reason) {
    if (child !== null) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
    buffer = '';
    for (const [, entry] of inflight) entry.resolve({ ok: false, error: `worker died (${reason})` });
    inflight.clear();
  }

  /** 拉起长驻 worker；失败返回 false。 */
  async function ensureWorker() {
    if (child !== null) return true;
    if (starting || !workerAllowed) return false;
    starting = true;
    try {
      const { spawn } = await import('node:child_process');
      const { WINDOWS_POWERSHELL } = await import('./win-toast.js');
      const workerScript = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'dsh-windows-notify', 'ps-worker.ps1');
      if (!existsSyncWorker(workerScript)) { starting = false; return false; }
      const proc = spawn(
        WINDOWS_POWERSHELL,
        ['-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', workerScript],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === '') continue;
          const sep = line.indexOf(' ');
          const id = sep > 0 ? line.slice(0, sep) : line;
          const payload = sep > 0 ? line.slice(sep + 1) : '';
          const entry = inflight.get(id);
          if (entry !== undefined) {
            inflight.delete(id);
            try { entry.resolve(JSON.parse(payload)); }
            catch { entry.resolve({ ok: false, error: 'worker returned invalid json' }); }
          }
        }
      });
      proc.once('exit', () => { child = null; });
      child = proc;
      starting = false;
      failures = 0;
      log('info', 'powerShell worker started (persistent toast channel)');
      return true;
    } catch (error) {
      starting = false;
      failures += 1;
      if (failures >= WORKER_MAX_FAILURES) workerAllowed = false;
      log('warn', `powerShell worker start failed (\${failures}/${WORKER_MAX_FAILURES}): ${String(error?.message ?? error)}`);
      return false;
    }
  }

  function existsSyncWorker(path) {
    try { return existsSync(path); } catch { return false; }
  }

  /** 发一条 toast：先试 worker，不行就回退逐条 spawn。 */
  async function send(options) {
    if (child !== null || (await ensureWorker())) {
      // worker 端只认 xmlBase64（XML 组装留在 Node 侧，与逐条 spawn 共用一份实现）。
      const winToast = await import('./win-toast.js');
      const xml = winToast.buildToastXml(options);
      const workerOptions = { ...options, xmlBase64: Buffer.from(xml, 'utf8').toString('base64') };
      const id = String(nextId);
      nextId += 1;
      const task = JSON.stringify({ op: 'show', options: workerOptions });
      const entry = { resolve: undefined };
      const result = await new Promise((resolve) => {
        entry.resolve = resolve;
        inflight.set(id, entry);
        try { child.stdin.write(`${id} ${Buffer.from(task, 'utf8').toString('base64')}\n`); }
        catch (error) {
          inflight.delete(id);
          resolve({ ok: false, error: String(error?.message ?? error) });
          killWorker('stdin write failed');
        }
      });
      if (result.ok === true) return result;
      // worker 路径失败 → 退回逐条 spawn（同一条通知不丢）。
      log('warn', `worker show failed, falling back to spawn: ${String(result.error ?? '')}`);
    }
    return await realSpawn(await buildSpawnScript(options, undefined), options.timeoutMs ?? 15000);
  }

  async function remove(target) {
    if (child !== null || (await ensureWorker())) {
      const id = String(nextId);
      nextId += 1;
      const task = JSON.stringify({ op: 'remove', target });
      const entry = { resolve: undefined };
      const result = await new Promise((resolve) => {
        entry.resolve = resolve;
        inflight.set(id, entry);
        try { child.stdin.write(`${id} ${Buffer.from(task, 'utf8').toString('base64')}\n`); }
        catch (error) {
          inflight.delete(id);
          resolve({ ok: false, error: String(error?.message ?? error) });
          killWorker('stdin write failed');
        }
      });
      if (result.ok === true) return result;
    }
    return await realSpawn(await buildSpawnScript(undefined, target), 8000);
  }

  return { send, remove, /** 测试/诊断用 */ isActive: () => child !== null };
}

/**
 * 组装「逐条 spawn」路径要跑的 PowerShell 脚本（与旧版 showWindowsToast /
 * removeWindowsToast 完全一致；worker 不可用时的回退）。
 */
async function buildSpawnScript(options, removeTarget) {
  const winToast = await import('./win-toast.js');
  if (removeTarget !== undefined) {
    const tag = typeof removeTarget.tag === 'string' && removeTarget.tag !== '' ? removeTarget.tag.slice(0, 16) : undefined;
    if (tag === undefined) return "Write-Error 'tag is required'";
    const group = typeof removeTarget.group === 'string' && removeTarget.group.length > 0 ? removeTarget.group.slice(0, 64) : 'dsh';
    const aumid = removeTarget.aumid ?? DEFAULT_AUMID;
    return [
      "$ErrorActionPreference = 'Stop'",
      '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
      `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove('${tag.replace(/'/g, "''")}', '${group.replace(/'/g, "''")}', '${aumid.replace(/'/g, "''")}')`,
      "Write-Output 'ok'",
    ].join('\n');
  }
  const xml = winToast.buildToastXml(options);
  return winToast.buildPowerShellScript(Buffer.from(xml, 'utf8').toString('base64'), options.aumid ?? DEFAULT_AUMID, options);
}

export { protocolCommandFor };