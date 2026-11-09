/**
 * 全部 HTTP 路由的注册（/send、/hello、/status、/recent、/clear、/decisions、
 * /focus、/decision、/config），以及统一的安全门：
 *
 *  1. 回环限定：所有路由只接受本机回环请求（此前只有写入口有校验，读接口与
 *     /send 是漏的——浏览器里任何网页都能对 127.0.0.1 的这些端口发跨源 POST，
 *     伪造通知内容做社工钓鱼）；
 *  2. Origin 校验：浏览器发起的跨源请求必带 Origin 头；非浏览器调用（curl、
 *     PowerShell、宿主进程内的 Electron 转发）没有 Origin，放行。两者合起来把
 *     CSRF/DNS-rebinding 挡在外面，又不影响脚本用法。
 *
 * @module dsh-windows-notify/http-routes
 */

import { isLoopbackRequest, readJsonBody, sendJson } from './http.js';

/** 本机允许的 Origin（页面就住在宿主自己的端口上；Electron 转发会保留它）。 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/**
 * 统一安全门：回环 +（有 Origin 时的）本机 Origin。返回拒绝响应或 undefined。
 * @param {import('node:http').IncomingMessage} req
 * @returns {{status: number, payload: object} | undefined} undefined = 放行
 */
export function guardRequest(req) {
  if (!isLoopbackRequest(req)) {
    return { status: 403, payload: { ok: false, error: 'loopback requests only' } };
  }
  const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim() : '';
  // 只有浏览器会带 Origin。带了但既不是本机来源也不是 file://（渲染页可能有
  // file:// 基），就当跨源攻击处理。非浏览器调用（curl / PowerShell）没有
  // Origin，不受影响。
  if (origin !== '' && origin !== 'null' && !LOCAL_ORIGIN_RE.test(origin)) {
    return { status: 403, payload: { ok: false, error: 'cross-origin requests are not allowed' } };
  }
  return undefined;
}

/**
 * 注册全部路由。每个 handler 先过 guardRequest（并顺手 noteOrigin）。
 *
 * @param {object} sctx - 注入 webServer 的子上下文
 * @param {object} io - 能力集合
 * @param {(path: string, handler: Function) => void} io.route - 注册一条 exact 路由
 * @param {object} io.api - ctx.windowsNotify 服务（send/status/recent/clearHistory）
 * @param {object} io.state - 宿主半边的共享状态（history/decisions/decisionSeq…）
 * @param {Function} io.answerDecision - 结算按钮 token
 * @param {Function} io.noteFocus - 记录前后台上报
 * @param {Function} io.noteOrigin - 从真实请求学宿主地址
 * @param {Function} io.ensureDecisionChannel - 注册按钮回传通道
 * @param {object} io.settingsBridge - { describeSelf, mutate } 配置桥
 * @param {string} io.entryId - settings 命名空间
 * @param {(level: string, message: string) => void} io.log
 */
export function registerRoutes(sctx, io) {
  const { api, state, answerDecision, noteFocus, noteOrigin, ensureDecisionChannel, settingsBridge, entryId, log } = io;

  /** 包了安全门与 noteOrigin 的路由注册。 */
  const route = (path, handler) => sctx.effect(() => sctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      noteOrigin(req);
      const denied = guardRequest(req);
      if (denied !== undefined) {
        sendJson(res, denied.status, denied.payload);
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        log('warn', `route ${path} threw: ${String(error?.message ?? error)}`);
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  route('/plugins/dsh-windows-notify/send', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const payload = await readJsonBody(req);
    if (typeof payload.title !== 'string' || payload.title.trim() === '') {
      sendJson(res, 400, { ok: false, error: 'title is required' });
      return;
    }
    const result = await api.send(payload);
    sendJson(res, result.delivered ? 200 : 503, result);
  });

  // 客户端半边在页面加载时 ping 一下：让宿主尽早知道自己的地址，
  // 这样第一条审批通知就带得上按钮。顺手把通道建好再回答，结果就是确定的。
  route('/plugins/dsh-windows-notify/hello', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const originNow = typeof state.origin === 'function' ? state.origin() : state.origin;
    if (originNow !== undefined && state.decisionChannel().status !== 'ready') {
      await ensureDecisionChannel(originNow);
    }
    // await 之后重新取：ensureDecisionChannel 会把状态对象整体替换（running → ready/failed）。
    sendJson(res, 200, { ok: true, origin: originNow, decision: state.decisionChannel().status });
  });

  route('/plugins/dsh-windows-notify/status', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, { ok: true, ...(await api.status()) });
  });

  route('/plugins/dsh-windows-notify/recent', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const limitRaw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 20;
    sendJson(res, 200, { ok: true, items: state.history.slice(0, limit) });
  });

  // 清空通知历史（侧栏「通知」页的清除按钮用）。
  route('/plugins/dsh-windows-notify/clear', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    api.clearHistory();
    sendJson(res, 200, { ok: true });
  });

  // 客户端半边拉这个增量：seq 单调递增，只回 since 之后的条目。
  route('/plugins/dsh-windows-notify/decisions', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const sinceRaw = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since'));
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    sendJson(res, 200, {
      ok: true,
      seq: state.decisionSeq,
      items: state.decisions.filter((decision) => decision.seq > since),
    });
  });

  // 客户端半边上报「DSH 窗口是不是在前台」：宿主是独立 Node 进程，拿不到
  // Electron 的窗口状态，只能由渲染进程告诉我们。带 TTL：心跳停了算后台。
  route('/plugins/dsh-windows-notify/focus', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, foreground: state.foreground(), windows: state.focus.size, ttlMs: state.focusTtlMs });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    const result = noteFocus(body.windowId, body.focused === true);
    sendJson(res, 200, { ok: true, ...result, ttlMs: state.focusTtlMs });
  });

  // 通知里「允许 / 拒绝」按钮的回传口：由 %LOCALAPPDATA% 下那个隐藏 PowerShell
  // 脚本 POST 过来，token 是一次性的随机值，且只接受本机回环请求。
  route('/plugins/dsh-windows-notify/decision', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
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
  });

  // 设置页用的配置桥：读写本 entry 的 Config，走 DSH 自己的 settings 服务
  // （和「设置」层同一个落盘位置）。客户端半边 lib/client.js 的页面只跟这两个
  // 路由打交道，因此不依赖任何私有客户端 API。
  route('/plugins/dsh-windows-notify/config', async (req, res) => {
    if (settingsBridge.describe === undefined || settingsBridge.mutate === undefined) {
      // settings 服务还没注入（引用容器未补齐）：明确降级而不是 TypeError 500。
      sendJson(res, 503, { ok: false, error: 'settings service is not available yet' });
      return;
    }
    if (req.method === 'GET') {
      const descriptor = settingsBridge.describe();
      if (descriptor === undefined) {
        sendJson(res, 404, { ok: false, error: `settings namespace "${entryId}" not found` });
        return;
      }
      sendJson(res, 200, { ok: true, ns: entryId, value: descriptor.value, revision: descriptor.revision });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length === 0) {
      sendJson(res, 400, { ok: false, error: 'ops is required' });
      return;
    }
    const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined;
    await settingsBridge.mutate(entryId, ops, expected);
    const descriptor = settingsBridge.describe();
    sendJson(res, 200, { ok: true, ns: entryId, value: descriptor?.value, revision: descriptor?.revision });
  });
}