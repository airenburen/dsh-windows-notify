// 按插件真实代码路径发一条「需要授权」样式的通知，用于肉眼确认观感与点击行为。
import { defaultIconPath, showWindowsToast } from '../lib/win-toast.js';
import { summarizeApproval } from '../lib/messages.js';

const summary = summarizeApproval({
  toolName: 'pwsh',
  subject: 'command',
  effectiveMode: 'workspace-write',
  requestedMode: 'danger-full-access',
  justification: '需要写入工作区以外的文件（示例文案）',
  agent: { session: { header: { cwd: 'D:\\杂类' } } },
}, 'zh');

console.log('icon :', defaultIconPath() ?? '(未找到，将不带图标)');
console.log('title:', summary.title);
console.log('body :', summary.body);
console.log('lines:', summary.lines.join(' | '));

const result = await showWindowsToast({
  ...summary,
  // 与插件默认一致：10 秒显示时间限制（到点从屏幕与操作中心移除），不用常驻的提醒样式。
  expiresInSeconds: Number(process.env.DSH_NOTIFY_DEMO_SECONDS ?? 10),
  sticky: false,
  silent: false,
  group: 'dsh',
  launch: 'dsh://open',
  aumid: 'com.deepseek.dsh',
  icon: defaultIconPath(),
});
console.log('send :', JSON.stringify(result));
