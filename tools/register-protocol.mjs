/**
 * 单独注册 / 检查「点击通知回到 DSH」用的 dsh-notify: 协议。
 *
 * 用法：
 *   node tools/register-protocol.mjs                      # 按当前进程推断
 *   node tools/register-protocol.mjs --exe "D:\DSH\DeepSeek Harness.exe"
 *   node tools/register-protocol.mjs --url http://127.0.0.1:19387
 *   node tools/register-protocol.mjs --check              # 只回读注册表
 */

import { detectLauncher, ensureProtocolRegistered, protocolCommandFor, readRegisteredCommand, DEFAULT_SCHEME } from '../lib/protocol.js';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const current = await readRegisteredCommand(DEFAULT_SCHEME);
console.log(`scheme   : ${DEFAULT_SCHEME}:`);
console.log(`current  : ${current ?? '(未注册)'}`);

if (args.includes('--check')) process.exit(0);

const exe = valueOf('--exe');
const url = valueOf('--url');
const launcher = exe !== undefined
  ? { kind: 'desktop', command: `"${exe}"`, label: exe.split(/[\\/]/).pop() }
  : url !== undefined
    ? { kind: 'browser', url, label: url }
    : detectLauncher();

console.log(`launcher : ${JSON.stringify(launcher)}`);
const command = protocolCommandFor(launcher);
if (command === undefined) {
  console.error('无法确定启动目标（既不是桌面端，也没有 DSH_WEB_URL）');
  process.exit(1);
}
console.log(`command  : ${command}`);

const result = await ensureProtocolRegistered({ launcher, force: true });
console.log(`register : ${JSON.stringify(result)}`);
console.log(`reread   : ${await readRegisteredCommand(DEFAULT_SCHEME)}`);
process.exit(result.ok ? 0 : 1);
