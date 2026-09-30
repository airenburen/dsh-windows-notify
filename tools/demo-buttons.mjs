/**
 * 现场演示「通知里的允许 / 拒绝按钮」：起一个替身宿主 → 用真实注册表协议 →
 * 发一条**真的**带按钮通知 → 打印任何一次点击回传。
 *
 * 不依赖 DSH：按钮点下去后激活的是本脚本注册的协议，回传会打在这里。
 * 结束（Ctrl+C 或超时）时把协议恢复成原来的命令——插件下次启动会重新注册成自己的。
 *
 * 用法：node tools/demo-buttons.mjs [等待秒数，默认 120]
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { showWindowsToast, DEFAULT_AUMID } from '../lib/win-toast.js';
import { DEFAULT_SCHEME, ensureDecisionProtocol, readRegisteredCommand, writeProtocolCommand } from '../lib/protocol.js';

const HOST = '127.0.0.1';
const WAIT_SECONDS = Number(process.argv[2] ?? 120);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const original = await readRegisteredCommand(DEFAULT_SCHEME);
console.log(`原协议命令: ${original ?? '(未注册)'}`);

let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  const url = new URL(req.url ?? '/', 'http://x');
  const choice = url.searchParams.get('choice');
  const token = url.searchParams.get('token');
  console.log(`\n[回传 #${hits}] ${new Date().toLocaleTimeString()} ${req.method} ${url.pathname}  choice=${choice}  token=${token}`);
  console.log(choice === 'allow' ? '  → 这就是「允许」被点到的样子（真插件里会以 allowed-once 结算这次审批）' : '  → 这就是「拒绝」被点到的样子（真插件里会以 rejected 结算）');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(0, HOST, resolve));
const port = server.address().port;
if (port === 3080) throw new Error('撞上了 DSH GUI 端口');
const base = `http://${HOST}:${port}`;
console.log(`替身宿主: ${base}`);

const registered = await ensureDecisionProtocol({ base, scheme: DEFAULT_SCHEME, force: true });
if (registered.ok !== true) throw new Error(`协议注册失败: ${registered.reason ?? 'unknown'}`);
console.log(`协议已指向回传脚本: ${registered.script}`);

const token = randomUUID().replace(/-/g, '').slice(0, 16);
const sent = await showWindowsToast({
  title: '点「允许」或「拒绝」试试',
  body: '这是按钮回传的现场演示：点哪个都会把选择发回本机（替身宿主），不涉及任何真实审批。',
  lines: ['（演示用替身宿主，真插件里会直接结算那次权限申请）'],
  actions: [
    { content: '允许', arguments: `${DEFAULT_SCHEME}:allow/${token}`, style: 'Success' },
    { content: '拒绝', arguments: `${DEFAULT_SCHEME}:reject/${token}`, style: 'Critical' },
  ],
  launch: 'dsh://open',
  actionText: '打开 DSH',
  tag: 'ap-demo',
  group: 'dsh',
  expiresInSeconds: Math.max(30, WAIT_SECONDS),
  aumid: DEFAULT_AUMID,
});
console.log(`通知发送结果: ${JSON.stringify(sent)}`);
console.log(`等你点按钮，最多 ${WAIT_SECONDS} 秒 …（Ctrl+C 可提前结束）`);

const deadline = Date.now() + WAIT_SECONDS * 1000;
let lastHits = 0;
// 一有人点就收工（并立刻把协议恢复原样），别让替身宿主长时间占着 dsh-notify:。
while (Date.now() < deadline) {
  await sleep(1000);
  if (hits !== lastHits) lastHits = hits;
  if (hits >= 1) break;
}

console.log(hits === 0 ? '\n没有收到回传（按钮没点，或系统没渲染出来）。' : `\n共收到 ${hits} 次回传。`);

server.close();
if (original === undefined) {
  const { spawnSync } = await import('node:child_process');
  spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${DEFAULT_SCHEME}`, '/f'], { windowsHide: true });
  console.log(`已删除演示用的 ${DEFAULT_SCHEME}: 注册项（插件下次启动会自己重建）`);
} else {
  const restored = await writeProtocolCommand(DEFAULT_SCHEME, original, true);
  console.log(`已恢复原协议命令（ok=${String(restored.ok)}）`);
}
