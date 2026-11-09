/**
 * 两条惰性注册的通道 + 审批按钮 token 的记账：
 *   - click   ：「点击通知回到 DSH」的目标（dsh://open 优先，dsh-notify: 兜底）；
 *   - decision：通知上「允许 / 拒绝」按钮的回传通道（隐藏 PowerShell → 本机回环 POST）。
 *
 * 两条通道都是「第一次用到才注册、成功/失败后缓存结果」；失败与成功共用同一个
 * ensure* 入口，由外部（lib/index.js）注入真实的注册函数，便于测试替换。
 *
 * @module dsh-windows-notify/channels
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_SCHEME } from './protocol.js';

/** 通道注册失败后的最小重试间隔（毫秒）：避免每条请求都空跑一轮注定失败的注册。 */
export const CHANNEL_RETRY_MS = 60_000;

/**
 * 判断一条缓存的通道状态此刻是否可用（ready，或失败但已过退避期可再试）。
 * @param {{status: string, at?: number}} entry - 通道缓存状态
 * @param {number} now
 * @param {number} [retryMs]
 */
export function channelUsable(entry, now, retryMs = CHANNEL_RETRY_MS) {
  if (entry === undefined || entry === null) return false;
  if (entry.status === 'ready' || entry.status === 'running') return true;
  if (entry.status === 'failed' && typeof entry.at === 'number' && now - entry.at < retryMs) return false;
  return true;
}

/**
 * 创建通道管理器。
 * @param {object} options
 * @param {Function} options.ensureDecisionProtocol - 回传协议注册（可注入替身）
 * @param {Function} options.resolveClickTarget - 点击目标解析（可注入替身）
 * @param {Function} options.detectLauncher - 启动方式探测（可注入替身）
 * @param {(level: string, message: string) => void} options.log
 */
export function createChannels({ ensureDecisionProtocol, resolveClickTarget, detectLauncher, log }) {
  const state = {
    /** 「点击通知回到 DSH」的目标 URI（惰性解析）。 */
    click: { status: 'pending' },
    /** 「允许 / 拒绝」按钮的回传通道状态（惰性注册）。 */
    decision: { status: 'pending' },
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
    const resolved = base ?? (typeof process.env.DSH_WEB_URL === 'string' && process.env.DSH_WEB_URL !== '' ? process.env.DSH_WEB_URL : undefined);
    if (resolved === undefined) {
      // 还不知道自己在哪个端口上：等第一个请求把地址带过来再注册（此刻先不发按钮）。
      state.decision = { status: 'failed', reason: 'no-web-url' };
      return state.decision;
    }
    if (state.decision.status === 'ready' && state.decision.base === resolved) return state.decision;
    if (state.decision.status === 'running' && state.decision.base === resolved) return await state.decision.promise;
    // 失败后退避：60 秒内不再空跑一轮注定失败的注册（可用性见 channelUsable）。
    if (state.decision.status === 'failed' && typeof state.decision.at === 'number' && Date.now() - state.decision.at < CHANNEL_RETRY_MS) {
      return state.decision;
    }

    state.decision = { status: 'running', base: resolved };
    const promise = (async () => {
      try {
        const result = await ensureDecisionProtocol({ scheme: DEFAULT_SCHEME, base: resolved });
        state.decision = { status: result.ok ? 'ready' : 'failed', base: resolved, ...result, ...(result.ok ? {} : { at: Date.now() }) };
        log(
          result.ok ? 'info' : 'warn',
          result.ok
            ? `decision channel ready at ${resolved}${result.changed === true ? ' (registered)' : ''}`
            : `decision channel unavailable: ${result.reason}`,
        );
      } catch (error) {
        state.decision = { status: 'failed', base: resolved, reason: String(error?.message ?? error), at: Date.now() };
        log('warn', `decision channel registration threw: ${state.decision.reason}`);
      }
      return state.decision;
    })();
    state.decision.promise = promise;
    return await promise;
  }

  /**
   * 解析「点击通知回到 DSH」的目标：桌面端优先直接用应用自己注册的 `dsh://open`
   * （Electron 的 second-instance 会把主窗口 restore + show + focus），
   * 否则注册本插件的协议兜底。结果缓存在 state.click。
   */
  async function ensureClickTarget() {
    if (state.click.status === 'ready') return state.click;
    if (state.click.status === 'running') return await state.click.promise;
    // 失败后退避：60 秒内沿用上次的失败结论，不反复打注册表。
    if (state.click.status === 'failed' && typeof state.click.at === 'number' && Date.now() - state.click.at < CHANNEL_RETRY_MS) {
      return state.click;
    }

    state.click = { status: 'running' };
    const promise = (async () => {
      try {
        const result = await resolveClickTarget({ scheme: DEFAULT_SCHEME, launcher: detectLauncher() });
        state.click = { status: result.ok ? 'ready' : 'failed', ...result, ...(result.ok ? {} : { at: Date.now() }) };
        log(
          result.ok ? 'info' : 'warn',
          result.ok
            ? `click target ${result.mode} → ${result.uri}${result.changed === true ? ' (registered)' : ''}`
            : `click target unavailable: ${result.reason}`,
        );
      } catch (error) {
        state.click = { status: 'failed', reason: String(error?.message ?? error), mode: 'none', at: Date.now() };
        log('warn', `click target resolution threw: ${state.click.reason}`);
      }
      return state.click;
    })();
    state.click.promise = promise;
    return await promise;
  }

  return { state, ensureDecisionChannel, ensureClickTarget };
}

/**
 * 审批按钮的 token 记账：挂起（offer）→ 结算（answer）→ 过期自动作废。
 * 纯内存、一个 Map；token 一次性、16 位十六进制随机。
 */
export function createDecisionTokens() {
  /** token → { settle, timer, tag }。 */
  const pending = new Map();

  /**
   * 挂一个待决定的 token。
   * @param {number} ttlSeconds - 按钮可点击窗口（也是 token 寿命）
   * @returns {{token: string, tag: string, promise: Promise<string>, cancel: Function}}
   */
  function offer(ttlSeconds) {
    const token = randomUUID().replace(/-/g, '').slice(0, 16);
    const tag = `ap-${token.slice(0, 8)}`;
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      pending.delete(token);
    }, Math.max(1, ttlSeconds) * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(token, { settle, timer, tag });
    return {
      token,
      tag,
      promise,
      cancel: () => {
        clearTimeout(timer);
        pending.delete(token);
      },
    };
  }

  /**
   * 用一次按钮点击结算一个 token。
   * @param {string} token
   * @param {string} choice - `allow` | `reject`
   * @returns {string | undefined} 结算出的 ApprovalOutcome（token 不存在/过期时 undefined）
   */
  function answer(token, choice) {
    const entry = pending.get(token);
    if (entry === undefined) return undefined;
    pending.delete(token);
    clearTimeout(entry.timer);
    const outcome = choice === 'reject' ? 'rejected' : 'allowed-once';
    entry.settle(outcome);
    return outcome;
  }

  return { pending, offer, answer };
}
