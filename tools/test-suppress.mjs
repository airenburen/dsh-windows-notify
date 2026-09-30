/**
 * 现场验证「前台静默」：发两对通知，对比 SuppressPopup 的行为。
 *
 *   1) 普通通知（会弹横幅）
 *   2) SuppressPopup = $true（不弹横幅、不响铃）
 *
 * 然后回读操作中心：两条都应该在里面（说明静默 ≠ 丢失），只是第一条会弹横幅。
 * 用法：node tools/test-suppress.mjs [aumid]
 */

import { DEFAULT_AUMID, removeWindowsToast, showWindowsToast } from '../lib/win-toast.js';

const aumid = process.argv[2] ?? DEFAULT_AUMID;
const stamp = new Date().toLocaleTimeString();

console.log('先弹一条普通通知（应看到横幅）…');
console.log(JSON.stringify(await showWindowsToast({
  title: '对照：普通通知',
  body: `${stamp} 这条会弹横幅。`,
  tag: 'dsh-suppress-loud',
  group: 'dsh',
  expiresInSeconds: 120,
  aumid,
})));

await new Promise((resolve) => setTimeout(resolve, 2500));

console.log('再发一条 SuppressPopup 的通知（不该有横幅，也别响）…');
console.log(JSON.stringify(await showWindowsToast({
  title: '静默：只进操作中心',
  body: `${stamp} 这条只进操作中心，不弹横幅。`,
  tag: 'dsh-suppress-quiet',
  group: 'dsh',
  suppressPopup: true,
  expiresInSeconds: 120,
  aumid,
})));

console.log('\n现在去操作中心（Win+N）看：两条都应该在。60 秒后自动清掉这两条，方便复跑。');
await new Promise((resolve) => setTimeout(resolve, 60000));

for (const tag of ['dsh-suppress-loud', 'dsh-suppress-quiet']) {
  console.log(`清理 ${tag}: ${JSON.stringify(await removeWindowsToast({ tag, group: 'dsh', aumid }))}`);
}
