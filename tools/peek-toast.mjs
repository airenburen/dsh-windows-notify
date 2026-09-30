/**
 * 只读探针：把操作中心里 DSH 的通知列出来，并从 toast XML 里抠出
 * 「允许 / 拒绝」按钮携带的 token 与 activation 参数。
 *
 * 用途：实机验证按钮链路时，需要知道那条审批通知到底带了什么参数
 * （也方便排查「按钮点了没反应」——能确认系统里真的存了这两个 action）。
 *
 * 用法：node tools/peek-toast.mjs [aumid]
 */

import { spawn } from 'node:child_process';

import { DEFAULT_AUMID, WINDOWS_POWERSHELL, encodeCommand, toastAvailability } from '../lib/win-toast.js';

const aumid = process.argv[2] ?? DEFAULT_AUMID;

if (!toastAvailability().available) {
  console.error('这台机器上没有 Windows PowerShell，无法读取操作中心');
  process.exit(1);
}

const script = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
  `$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${aumid}')`,
  'foreach ($item in $items) {',
  "  Write-Output ('---TAG---' + $item.Tag)",
  '  Write-Output $item.Content.GetXml()',
  '}',
].join('\n');

const run = () =>
  new Promise((resolve, reject) => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `powershell exit ${String(code)}`))));
  });

const raw = await run();
const blocks = raw.split(/---TAG---/).slice(1);
console.log(`aumid: ${aumid}`);
console.log(`操作中心里 DSH 的通知: ${blocks.length} 条`);

let found = 0;
for (const block of blocks) {
  const newline = block.indexOf('\n');
  const tag = newline === -1 ? block.trim() : block.slice(0, newline).trim();
  const xml = newline === -1 ? '' : block.slice(newline + 1);
  const titles = [...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((match) => match[1]);
  const actions = [...xml.matchAll(/<action content="([^"]*)" arguments="([^"]*)"[^>]*\/>/g)].map((match) => ({ content: match[1], arguments: match[2] }));
  const decision = actions.map((action) => /:(\w+)\/([0-9a-f]+)$/.exec(action.arguments)).find(Boolean);
  console.log(`\n[${tag}] ${titles[0] ?? ''}${titles[1] === undefined ? '' : ` — ${titles[1]}`}`);
  if (actions.length === 0) {
    console.log('   （没有按钮）');
    continue;
  }
  found += 1;
  for (const action of actions) console.log(`   按钮「${action.content}」→ ${action.arguments}`);
  if (decision !== undefined) console.log(`   → 可用：Start-Process "dsh-notify:${decision[1]}/${decision[2]}"`);
}

console.log(`\n带按钮的通知: ${found} 条`);
