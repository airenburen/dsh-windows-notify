/**
 * Windows 侧真实动作的自检：发一条真通知、验证协议命令推导、检查通知是否落到操作中心。
 *
 * 用法：node test/windows.mjs            （只做静态/推导检查）
 *       node test/windows.mjs --toast    （额外发一条真通知，并查操作中心历史）
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import {
  DEFAULT_AUMID,
  WINDOWS_POWERSHELL,
  buildPowerShellScript,
  buildToastXml,
  encodeCommand,
  escapeXml,
  fileUri,
  showWindowsToast,
  toastAvailability,
} from '../lib/win-toast.js';
import { DEFAULT_SCHEME, decisionScript, decisionShimPath, detectLauncher, protocolCommandFor, readRegisteredCommand } from '../lib/protocol.js';
import { summarizeApproval, summarizeQuestion } from '../lib/messages.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('# win-toast');
check('XML 转义', () => {
  assert.equal(escapeXml('a & <b> "c" \'d\''), 'a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;');
});
check('file:// URI', () => {
  assert.equal(fileUri('D:\\DSH\\resources\\icon.png'), 'file:///D:/DSH/resources/icon.png');
});
check('toast XML 带 protocol 激活与按钮', () => {
  const xml = buildToastXml({ title: '标题', body: '正文', launch: 'dsh-notify:focus', actionText: '打开 DSH', sticky: true });
  assert.match(xml, /^<toast /);
  assert.match(xml, /scenario="reminder"/);
  assert.match(xml, /activationType="protocol"/);
  assert.match(xml, /launch="dsh-notify:focus"/);
  assert.match(xml, /<action content="打开 DSH" arguments="dsh-notify:focus" activationType="protocol"\/>/);
  assert.match(xml, /<text>标题<\/text>/);
  assert.match(xml, /<text>正文<\/text>/);
  assert.doesNotMatch(xml, /<tag>/, 'tag 不是 toast XML 的子元素');
});
check('不点击时不带激活属性', () => {
  const xml = buildToastXml({ title: 't' });
  assert.doesNotMatch(xml, /activationType/);
  assert.doesNotMatch(xml, /<actions>/);
});
check('任意按钮：允许 / 拒绝（带配色），没给就用默认按钮', () => {
  const xml = buildToastXml({
    title: '需要授权',
    launch: 'dsh://open',
    actions: [
      { content: '允许', arguments: 'dsh-notify:allow/tok123', style: 'Success' },
      { content: '拒绝', arguments: 'dsh-notify:reject/tok123', style: 'Critical' },
    ],
  });
  assert.match(xml, /useButtonStyle="true"/);
  assert.match(xml, /<action content="允许" arguments="dsh-notify:allow\/tok123" activationType="protocol" hint-button-style="Success"\/>/);
  assert.match(xml, /<action content="拒绝" arguments="dsh-notify:reject\/tok123" activationType="protocol" hint-button-style="Critical"\/>/);
  assert.doesNotMatch(xml, /打开 DSH/, '给了自定义按钮就不再塞默认按钮');
  assert.match(xml, /launch="dsh:\/\/open"/, '点正文仍然回到 DSH');
  assert.match(xml, /duration="long"/, '有按钮的用长横幅，给点击留时间');

  const plain = buildToastXml({ title: 't', launch: 'dsh://open' });
  assert.doesNotMatch(plain, /useButtonStyle/);
  assert.match(plain, /<action content="打开 DSH" arguments="dsh:\/\/open" activationType="protocol"\/>/);
});
check('PowerShell 脚本纯 ASCII 且含 AUMID', () => {
  const script = buildPowerShellScript(Buffer.from('<toast/>').toString('base64'), DEFAULT_AUMID, { tag: 'abc', group: 'dsh' });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(script), '脚本必须是纯 ASCII');
  assert.match(script, /CreateToastNotifier\('com\.deepseek\.dsh'\)/);
  assert.match(script, /\$toast\.Tag = 'abc'/);
  assert.doesNotMatch(script, /ExpirationTime/, '没设时限时不应写 ExpirationTime');
  assert.ok(encodeCommand(script).length > 0);
});
check('显示时间限制：写 ExpirationTime，且不再用常驻的提醒样式', () => {
  const script = buildPowerShellScript(Buffer.from('<toast/>').toString('base64'), DEFAULT_AUMID, { tag: 'abc', expiresInSeconds: 10 });
  assert.match(script, /\$toast\.ExpirationTime = \[DateTimeOffset\]::Now\.AddSeconds\(10\)/);
  const rounded = buildPowerShellScript(Buffer.from('<toast/>').toString('base64'), DEFAULT_AUMID, { expiresInSeconds: 7.6 });
  assert.match(rounded, /AddSeconds\(8\)/, '秒数取整');

  const limitedSticky = buildToastXml({ title: 't', sticky: true, expiresInSeconds: 10 });
  assert.doesNotMatch(limitedSticky, /scenario="reminder"/, '有时限时提醒样式会顶掉时限，必须关掉');
  assert.match(limitedSticky, /duration="short"/);

  const longLimited = buildToastXml({ title: 't', expiresInSeconds: 30 });
  assert.match(longLimited, /duration="long"/, '超过 25 秒用长横幅');

  const unlimitedSticky = buildToastXml({ title: 't', sticky: true });
  assert.match(unlimitedSticky, /scenario="reminder"/);
  assert.match(unlimitedSticky, /duration="long"/);
});

check('前台静默：SuppressPopup 只在要求时才写进脚本', () => {
  const plain = buildPowerShellScript(Buffer.from('<toast/>').toString('base64'), DEFAULT_AUMID, {});
  assert.ok(!plain.includes('SuppressPopup'), '默认不设 SuppressPopup');
  const quiet = buildPowerShellScript(Buffer.from('<toast/>').toString('base64'), DEFAULT_AUMID, { suppressPopup: true, expiresInSeconds: 30 });
  assert.match(quiet, /\$toast\.SuppressPopup = \$true/);
  assert.match(quiet, /ExpirationTime/, '静默不影响显示时间限制');
  assert.ok(!quiet.includes('SuppressPopup = $false'));
});

check('按钮回传脚本：纯 ASCII、带宿主地址、解析 token/choice', () => {
  const script = decisionScript('http://127.0.0.1:19387');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(script), 'PS 5.1 按 ANSI 读无 BOM 文件，脚本必须纯 ASCII');
  assert.match(script, /\$Base = 'http:\/\/127\.0\.0\.1:19387'/);
  assert.match(script, /dsh-notify:/, '要从 URI 里剥掉协议头');
  assert.match(script, /decision\?token=/);
  assert.match(script, /Invoke-RestMethod -Method Post/);
  assert.match(decisionShimPath('C:\\Users\\x\\AppData\\Local'), /dsh-windows-notify[\\/]decision\.ps1$/);
});

console.log('# protocol');
check('桌面端（Electron as node）推导为应用本体', () => {
  const launcher = detectLauncher({ ELECTRON_RUN_AS_NODE: '1', DSH_WEB_URL: 'http://127.0.0.1:19387' }, 'D:\\DSH\\DeepSeek Harness.exe');
  assert.equal(launcher.kind, 'desktop');
  assert.equal(protocolCommandFor(launcher), '"D:\\DSH\\DeepSeek Harness.exe"');
});
check('继承 ELECTRON_RUN_AS_NODE 的 node.exe 不会被误判成桌面端', () => {
  // 关键：判据只能是「execPath 不是 node.exe」，不能看 ELECTRON_RUN_AS_NODE
  //（那个变量会被继承，早先就是它把打包内的 node.exe 误判成了桌面应用）。
  const launcher = detectLauncher(
    { ELECTRON_RUN_AS_NODE: '1', DSH_WEB_URL: 'http://127.0.0.1:19387' },
    'C:\\some\\runtime\\node\\bin\\node.exe',
  );
  assert.equal(launcher.kind, 'browser');
  assert.equal(detectLauncher({ ELECTRON_RUN_AS_NODE: '1', DSH_WEB_URL: 'http://127.0.0.1:19387' }, process.execPath).kind, 'browser', '真实 node 进程也算浏览器模式');
});
check('纯 node 运行推导为浏览器地址', () => {
  const launcher = detectLauncher({ DSH_WEB_URL: 'http://127.0.0.1:19387' }, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(launcher.kind, 'browser');
  const command = protocolCommandFor(launcher, process.env.TEMP);
  assert.match(command, /open-dsh\.cmd" %1$/);
});
check('无地址时不可用', () => {
  assert.equal(detectLauncher({}, 'C:\\Program Files\\nodejs\\node.exe').kind, 'none');
  assert.equal(protocolCommandFor({ kind: 'none' }), undefined);
});

console.log('# messages');
check('批准请求摘要', () => {
  const summary = summarizeApproval({
    toolName: 'pwsh',
    subject: 'command',
    effectiveMode: 'workspace-write',
    requestedMode: 'danger-full-access',
    justification: '需要读取工作区外的文件',
    agent: { session: { header: { cwd: 'D:\\杂类' } } },
  }, 'zh');
  assert.equal(summary.title, 'DSH 需要你的授权');
  assert.match(summary.body, /pwsh/);
  assert.ok(summary.lines.some((line) => line.includes('danger-full-access')));
  assert.equal(summary.tag, 'dsh-approval');
});
check('提问摘要（缺字段也不炸）', () => {
  const summary = summarizeQuestion({ questions: [{ id: 'q1', question: '要继续吗？', header: '确认', options: [{ label: '继续' }, { label: '停止' }] }] }, 'zh');
  assert.equal(summary.body, '要继续吗？');
  assert.ok(summary.lines.some((line) => line.includes('继续')));
  const empty = summarizeQuestion(undefined, 'zh');
  assert.equal(empty.title, 'DSH 有问题要问你');
});

console.log('# availability');
const availability = toastAvailability();
console.log(`  platform=${process.platform} available=${String(availability.available)} reason=${availability.reason}`);
console.log(`  powershell=${WINDOWS_POWERSHELL}`);

const wantToast = process.argv.includes('--toast');
if (wantToast) {
  console.log('# live toast');
  const aumid = process.env.DSH_NOTIFY_TEST_AUMID ?? DEFAULT_AUMID;
  const before = await historyCount(aumid);
  const result = await showWindowsToast({
    title: 'DSH 通知插件自检',
    body: '如果你看到这条通知，说明 Windows 通知通道可用。',
    lines: ['点击应回到 DSH（协议 ' + DEFAULT_SCHEME + ':focus）'],
    launch: `${DEFAULT_SCHEME}:focus`,
    actionText: '打开 DSH',
    tag: 'dsh-selftest',
    group: 'dsh',
    aumid,
  });
  console.log(`  send result: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `toast 发送失败: ${result.error ?? result.skipped}`);
  const after = await historyCount(aumid);
  console.log(`  action-center history: before=${before} after=${after}`);
  passed += 1;
} else {
  console.log('# live toast  (跳过；加 --toast 才会真的弹通知)');
}

// 显示时限的真实行为：设了 ExpirationTime 的那条到点应从操作中心消失，对照那条还在。
if (process.argv.includes('--expire')) {
  console.log('# live expiry (约 15 秒)');
  const aumid = process.env.DSH_NOTIFY_TEST_AUMID ?? DEFAULT_AUMID;
  const expiring = await showWindowsToast({
    title: '时限测试：约 6 秒后自动消失',
    body: '设了显示时间限制的这条不应该留在操作中心。',
    tag: 'dsh-exp-test',
    group: 'dsh',
    expiresInSeconds: 6,
    aumid,
  });
  const keeping = await showWindowsToast({
    title: '对照：不设时限',
    body: '这条没有 ExpirationTime，应该一直留在操作中心。',
    tag: 'dsh-keep-test',
    group: 'dsh',
    aumid,
  });
  console.log(`  send: expiring=${JSON.stringify(expiring)} keeping=${JSON.stringify(keeping)}`);
  assert.equal(expiring.ok, true);
  assert.equal(keeping.ok, true);
  const immediate = await historyTags(aumid);
  console.log(`  immediately : ${immediate.join(',') || '(空)'}`);
  assert.ok(immediate.includes('dsh-exp-test'), '设了时限的这条刚发出时应还在');
  assert.ok(immediate.includes('dsh-keep-test'), '对照那条刚发出时应还在');
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const later = await historyTags(aumid);
  console.log(`  after 12s   : ${later.join(',') || '(空)'}`);
  assert.ok(!later.includes('dsh-exp-test'), '设了时限的这条应已从操作中心移除');
  assert.ok(later.includes('dsh-keep-test'), '没设时限的对照那条应还在');
  passed += 1;
} else {
  console.log('# live expiry  (跳过；加 --expire 才会真的验证到点消失)');
}

console.log(`\n${passed} checks passed.`);

/** 读操作中心里该 AUMID 所有通知的 tag。 */
async function historyTags(aumid) {
  const script = [
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    `$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${aumid}')`,
    'Write-Output (($items | ForEach-Object { $_.Tag }) -join \',\')',
  ].join('\n');
  return await new Promise((resolve) => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('error', () => resolve([]));
    child.once('close', () => resolve(out.trim() === '' ? [] : out.trim().split(',').map((tag) => tag.trim())));
  });
}

/** 读操作中心里该 AUMID 的通知数量（验证 toast 真的被系统接收）。 */
async function historyCount(aumid) {
  const script = [
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    `$items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${aumid}')`,
    'Write-Output $items.Count',
  ].join('\n');
  return await new Promise((resolve) => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('error', () => resolve('n/a'));
    child.once('close', () => resolve(out.trim() || 'n/a'));
  });
}

void join;
