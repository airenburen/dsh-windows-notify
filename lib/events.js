/**
 * 四类「会话状态 → 通知」的事件监听：审批请求、AI 提问、一轮结束、会话出错。
 *
 * 设计约束：
 *  - 监听器里抛错会打断批准/提问流程，所以一切入口都过 guard()；
 *  - 无论通知能力如何，approval/request 的 next() 必须照常挂上，否则审批被卡住；
 *  - 通知文案与高危判定在 lib/messages.js；这里的职责只是编排（含按钮竞速）。
 *
 * @module dsh-windows-notify/events
 */

import { DEFAULT_AUMID } from './win-toast.js';
import { DEFAULT_SCHEME } from './protocol.js';
import {
  dictionary,
  isPrivilegedApproval,
  summarizeApproval,
  summarizeError,
  summarizeQuestion,
  summarizeTurnEnd,
} from './messages.js';

/**
 * 注册全部事件监听。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {object} io - 宿主半边的能力集合（由 lib/index.js 组装）
 * @param {(key: string, fallback: unknown) => unknown} io.read - 读配置
 * @param {(request: object) => Promise<object>} io.fire - 发通知（绝不抛回事件瀑布）
 * @param {() => 'zh' | 'en'} io.lang - 当前语言
 * @param {import('./channels.js').ReturnType<typeof import('./channels.js').createDecisionTokens>} io.tokens - 按钮 token 记账
 * @param {() => {status: string, ok?: boolean}} io.decisionChannel - 按钮回传通道状态
 * @param {Function} io.removeToast - 从操作中心撤下一条通知
 * @param {(level: string, message: string) => void} io.log
 * @param {(record: object) => void} io.recordDecision - 记一条「从通知按钮结算」的事实
 * @param {Function} [removeWindowsToast] - 测试注入口未给 removeToast 时的缺省实现
 */
export function registerEvents(ctx, io, removeWindowsToast) {
  const { read, fire, lang, tokens, decisionChannel, removeToast, log, recordDecision } = io;

  /** 包一层 try/catch 的事件处理：事件监听里抛错会打断批准/提问流程。 */
  const guard = (source, fn) => {
    try {
      fn();
    } catch (error) {
      log('warn', `${source} handler threw: ${String(error?.message ?? error)}`);
    }
  };

  ctx.on('approval/request', (request, next) => {
    // 无论按钮能不能用，后面的 answerer（GUI）都必须照常挂上，否则审批会被卡住。
    const composed = Promise.resolve().then(() => next());
    // 竞赛输掉的那条不要再冒泡成 unhandled rejection。
    composed.catch(() => {});

    if (!read('notifyApproval', true)) return composed;

    // 高危审批（默认 danger-full-access，可用 privilegedModes 扩展）**不给按钮**：
    // 通知上的「允许」太容易误点，而误点的代价是不再受工作区限制。
    // 这类只提示去界面确认（decisionButtonsFor=all 可恢复）。
    const privileged = isPrivilegedApproval(request, read('privilegedModes', undefined));
    const buttonsAllowedByRisk = read('decisionButtonsFor', 'safe-only') === 'all' || !privileged;
    const offersButtons = read('decisionButtons', true) === true
      && buttonsAllowedByRisk
      && decisionChannel().status === 'ready'
      && decisionChannel().ok === true;

    if (!offersButtons) {
      guard('approval', () => {
        // 只在「按钮是被风险规则拦下」时提示去界面；用户自己关掉按钮就不啰嗦了。
        const summary = summarizeApproval(request, lang(), {
          guiOnly: read('decisionButtons', true) === true && !buttonsAllowedByRisk,
        });
        summary.agent = request?.agent;
        // tag 唯一化（#4）：并发的高危审批不能互相覆盖/被去重吞掉。
        // 带 callId 时按 callId 派生（同一次请求的重试天然同 tag → 去重仍生效）；
        // 没有 callId 就保持固定 tag（旧行为：短窗内同类审批合并，不刷屏）。
        const callId = typeof request?.callId === 'string' && request.callId !== '' ? request.callId.slice(0, 16) : undefined;
        fire({ ...summary, source: 'approval', ...(callId !== undefined ? { tag: `${summary.tag}:${callId}` } : {}) });
      });
      return composed;
    }

    // 「只有允许 / 拒绝」的权限申请：做两个按钮，点哪一个都直接结算这次审批。
    const configured = Number(read('decisionSeconds', 300));
    const ttl = Number.isFinite(configured) && configured > 0 ? configured : undefined;
    const pending = tokens.offer(ttl ?? Math.max(30, Number(read('displaySeconds', 10)) || 30));
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
      void removeToast({
        tag: pending.tag,
        group: 'dsh',
        aumid: read('aumid', DEFAULT_AUMID),
      }).catch(() => {});
      if (decidedByToast) {
        log('info', `approval decided from the toast: ${String(outcome)}`);
        // 观测用：客户端半边把卡片收掉时，GUI 那条链会迟到地回一个答案——
        // 日志里能看到这一行，就说明清卡动作真的发生了（debugLog=true 时可见）。
        composed.then(
          (late) => log('info', `GUI chain answered after the toast decision: ${String(late)}`),
          () => {},
        ).catch(() => {});
      }
      // 无论谁先答（含 GUI 先答），历史留痕都交给 recordDecision 统一处理：
      // 它内部只把「从通知按钮结算」的写进 /decisions 增量（GUI 先答的不产生事实）。
      recordDecision({ request, outcome, decidedByToast, summary, tag: pending.tag });
      return outcome;
    });
  });

  ctx.on('user-questions/request', (request, next) => {
    if (read('notifyQuestion', true)) {
      guard('question', () => {
        const summary = summarizeQuestion(request, lang());
        fire({ ...summary, source: 'user-question', agent: request?.agent });
      });
    }
    return next();
  });

  ctx.on('agent/turn-stopping', (payload) => {
    if (!read('notifyTurnEnd', false)) return;
    guard('turn-end', () => {
      const summary = summarizeTurnEnd(payload, lang());
      // tag 唯一化：多会话几乎同时结束，固定 tag 会让第二条被去重静默吞掉。
      fire({ ...summary, sticky: false, source: 'turn-end', tag: turnTag(payload, summary), agent: payload?.agent });
    });
  });

  ctx.on('agent/error', (payload) => {
    if (!read('notifyError', true)) return;
    guard('agent-error', () => {
      const summary = summarizeError(payload, lang());
      // tag 唯一化：两个会话同时出错，第二条不能被去重吞掉。
      fire({ ...summary, sticky: false, source: 'agent-error', tag: errorTag(payload, summary), agent: payload?.agent });
    });
  });
}

/** 一轮结束通知的 tag：带会话标识，同会话短时间重复才去重。 */
function turnTag(payload, summary) {
  const id = sessionKey(payload);
  return id === undefined ? summary.tag : `${summary.tag}:${id}`;
}

/** 出错通知的 tag：带会话标识 + 错误指纹（同会话同一错误才去重）。 */
function errorTag(payload, summary) {
  const id = sessionKey(payload);
  const message = payload?.error?.message ?? (typeof payload?.error === 'string' ? payload.error : payload?.message);
  // FNV-1a 指纹：同类错误归并成同一个 tag，不同错误各占一条通知。
  const fingerprint = typeof message === 'string' && message.trim() !== '' ? fnv1a(message.trim()) : 0;
  const short = fingerprint.toString(16).padStart(8, '0');
  return id === undefined ? `${summary.tag}-${short}` : `${summary.tag}:${id}-${short}`;
}

/** 32 位 FNV-1a。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 会话标识（id 优先，其次 cwd 末段），取不到返回 undefined。 */
function sessionKey(payload) {
  const id = payload?.agent?.id;
  if (typeof id === 'string' && id.trim() !== '') return id.slice(0, 24);
  const cwd = payload?.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? cwd;
    return last.slice(0, 24);
  }
  return undefined;
}