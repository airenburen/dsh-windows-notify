/**
 * 「点通知里的允许 / 拒绝按钮」这条链路端到端自检——不依赖 DSH，也不用手点。
 *
 * 链路是：通知按钮 → Windows 执行 `dsh-notify:allow/<token>` → 注册表里那条命令启动
 * 隐藏 PowerShell → 跑 decision.ps1 → POST 到本机回环接口。
 *
 * 这里起一个替身 HTTP 服务当「宿主」，用真实注册表注册真实协议，再用
 * `Start-Process "dsh-notify:..."` 模拟系统激活，验证服务真的收到了带 token/choice 的
 * POST。跑完会把协议改回原来的命令（或删除测试用的那条）。
 *
 * 用法（需要写 HKCU 的权限）：node tools/test-decision.mjs
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_SCHEME,
  decisionScript,
  ensureDecisionProtocol,
  readRegisteredCommand,
  writeProtocolCommand,
} from '../lib/protocol.js';

const PORT = Number(process.env.DSH_NOTIFY_TEST_PORT ?? 0) || undefined;
const HOST = '127.0.0.1';

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ok  ${label}`);
};

const original = await readRegisteredCommand(DEFAULT_SCHEME);
console.log(`原有 ${DEFAULT_SCHEME}: 注册命令: ${original ?? '(未注册)'}`);

const received = [];
const server = createServer((req, res) => {
  received.push({ method: req.method, url: req.url });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, outcome: 'allowed-once' }));
});
await new Promise((resolve) => server.listen(PORT ?? 0, HOST, resolve));
const address = server.address();
const base = `http://${HOST}:${address.port}`;
console.log(`替身宿主: ${base}`);
// 3080 是 DSH GUI 端口，绝不被本测试占用（监听随机端口，这里只做断言）。
if (address.port === 3080) throw new Error('测试端口撞上了 DSH GUI 端口');
ok(`替身服务监听随机端口 ${address.port}（避开 3080）`);

try {
  const registered = await ensureDecisionProtocol({ base, scheme: DEFAULT_SCHEME, force: true });
  console.log(`注册结果: ${JSON.stringify({ ok: registered.ok, changed: registered.changed, script: registered.script })}`);
  if (registered.ok !== true) throw new Error(`决策协议注册失败: ${registered.reason ?? 'unknown'}`);
  ok('把按钮协议注册成「隐藏 PowerShell 跑回传脚本」');

  const command = await readRegisteredCommand(DEFAULT_SCHEME);
  console.log(`当前命令: ${command}`);
  if (!String(command).includes('decision.ps1')) throw new Error('注册表里的命令不是回传脚本');
  if (!String(command).includes('-WindowStyle Hidden')) throw new Error('回传脚本不是隐藏运行');
  ok('注册表命令指向 decision.ps1 且隐藏窗口');

  // 真·模拟系统激活：Windows 会执行注册表里那条命令并把 URI 作为参数传进去。
  const token = 'a1b2c3d4e5f60718';
  spawnSync('cmd.exe', ['/c', 'start', '', `${DEFAULT_SCHEME}:allow/${token}`], { windowsHide: true });
  const deadline = Date.now() + 15000;
  while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));

  if (received.length === 0) throw new Error('15 秒内没收到回传 POST（协议没生效或脚本没跑起来）');
  const hit = received[0];
  console.log(`收到: ${hit.method} ${hit.url}`);
  if (hit.method !== 'POST') throw new Error(`应为 POST，实际 ${hit.method}`);
  if (!String(hit.url).includes(`token=${token}`)) throw new Error('token 没传到');
  if (!String(hit.url).includes('choice=allow')) throw new Error('choice 没传到');
  ok('真实激活 → 隐藏脚本 → POST 带着 token 与 choice 到达宿主');

  received.length = 0;
  spawnSync('cmd.exe', ['/c', 'start', '', `${DEFAULT_SCHEME}:reject/${token}`], { windowsHide: true });
  const deadline2 = Date.now() + 15000;
  while (received.length === 0 && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 250));
  if (received.length === 0) throw new Error('拒绝按钮没回传');
  if (!String(received[0].url).includes('choice=reject')) throw new Error('reject 没传到');
  ok('「拒绝」同样回传（choice=reject）');

  const script = decisionScript('http://127.0.0.1:9999');
  if (/[^\x00-\x7F]/.test(script)) throw new Error('回传脚本必须纯 ASCII（PS 5.1 按 ANSI 读无 BOM 文件）');
  if (!script.includes("$Base = 'http://127.0.0.1:9999'")) throw new Error('脚本没带上宿主地址');
  ok('回传脚本纯 ASCII 且带宿主地址');
} finally {
  server.close();
  if (original === undefined) {
    const removed = spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${DEFAULT_SCHEME}`, '/f'], { windowsHide: true });
    console.log(`清理: 删除测试用的 ${DEFAULT_SCHEME}: 键（exit ${removed.status}）`);
  } else {
    const restored = await writeProtocolCommand(DEFAULT_SCHEME, original, true);
    console.log(`清理: 恢复原有 ${DEFAULT_SCHEME}: 命令（ok=${String(restored.ok)}）`);
  }
}

console.log(`\n${passed} checks passed.`);
