/**
 * HTTP 路由共用的小工具：请求体解析、JSON 回写、回环判定。
 *
 * 全部纯函数、不持有状态；宿主半边的 lib/index.js 与 lib/http-routes.js 共用。
 *
 * @module dsh-windows-notify/http
 */

/** 读取请求体（上限 64KB）。 */
export async function readJsonBody(req, limit = 64 * 1024) {
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

/** 请求是否来自本机回环（状态写入与按钮回传口只允许本机）。 */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 回一个 JSON（统一 no-store，避免中间层缓存状态接口）。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
