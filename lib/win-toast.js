/**
 * Windows 原生 Toast 通知发送器（宿主半边，纯 Node + Windows PowerShell 5.1）。
 *
 * 为什么要绕 PowerShell：
 *  - DSH 的宿主是一个独立的 Node 子进程（桌面端由 Electron 以 ELECTRON_RUN_AS_NODE
 *    拉起），插件拿不到 Electron 的 Notification / BrowserWindow，只能用系统 API。
 *  - WinRT 的 ToastNotificationManager 只有 .NET Framework 的 Windows PowerShell 5.1
 *    能直接投影（PowerShell 7 已经移除 WinRT 投影），所以固定调用 powershell.exe。
 *
 * 命令行走 -EncodedCommand（UTF-16LE base64），XML 走 base64 参数，脚本本体保持纯
 * ASCII：这样中文、emoji、引号、$ 都不会被命令行/代码页二次解释。
 *
 * @module dsh-windows-notify/win-toast
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 系统 Windows PowerShell 5.1 的绝对路径（Win10/11 默认存在）。 */
export const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

/**
 * 默认 AppUserModelID：桌面版 DSH 的「开始菜单」快捷方式 AppID
 * （`Get-StartApps` 里 DeepSeek Harness 的 AppID），用它发通知时来源显示为
 * 「DeepSeek Harness」并带应用图标；AUMID 必须在开始菜单注册过，通知才会显示。
 */
export const DEFAULT_AUMID = 'com.deepseek.dsh';

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** XML 文本转义。 */
export function escapeXml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

/** 截断到 Windows toast 允许的 tag 长度。 */
function safeTag(tag) {
  return tag === undefined || tag === null || tag === '' ? undefined : String(tag).slice(0, 16);
}

/** 把本地绝对路径转成 toast 可用的 file:// URI。 */
export function fileUri(path) {
  return `file:///${String(path).replace(/\\/g, '/').replace(/^\//, '')}`;
}

/** 猜测 DSH 应用图标：桌面端 resources/icon.png。 */
export function defaultIconPath() {
  try {
    const candidate = join(process.execPath, '..', 'resources', 'icon.png');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装 toast XML。
 * @param {{title: string, body?: string, launch?: string, actionText?: string,
 *   actions?: Array<{content: string, arguments: string, style?: 'Success'|'Critical'}>,
 *   silent?: boolean, sticky?: boolean, tag?: string, group?: string,
 *   icon?: string, attribution?: string, lines?: string[]}} options
 * @returns {string} toast XML
 */
export function buildToastXml(options) {
  const {
    title,
    body,
    launch,
    actionText = '打开 DSH',
    actions: actionList,
    silent = false,
    sticky = false,
    expiresInSeconds,
    tag,
    group,
    icon,
    attribution,
    lines = [],
  } = options;

  const activated = typeof launch === 'string' && launch.length > 0;
  // 自定义按钮（例如「允许 / 拒绝」）优先；没给就用默认的「打开 DSH」。
  // 带按钮的 toast 需要 useButtonStyle 才能让 hint-button-style 的配色生效。
  const buttons = Array.isArray(actionList) && actionList.length > 0
    ? actionList
    : (activated ? [{ content: actionText, arguments: launch }] : []);
  const useButtonStyle = buttons.some((button) => typeof button.style === 'string' && button.style !== '');

  // 「提醒」样式（scenario=reminder）会一直挂在屏幕上直到用户处理，跟显示时限互相矛盾；
  // 有时限时一律用普通横幅：>25s 用 long，否则用 short，真正的下屏时间由
  // ToastNotification.ExpirationTime 兜底（见 buildPowerShellScript）。
  const limited = typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0;
  const reminder = sticky === true && !limited;
  const longBanner = reminder || (limited && expiresInSeconds > 25) || buttons.length > 0;
  const rootAttributes = [
    reminder ? 'scenario="reminder"' : '',
    activated ? 'activationType="protocol"' : '',
    activated ? `launch="${escapeXml(launch)}"` : '',
    useButtonStyle ? 'useButtonStyle="true"' : '',
    `duration="${longBanner ? 'long' : 'short'}"`,
  ]
    .filter(Boolean)
    .join(' ');

  const textNodes = [`<text>${escapeXml(title)}</text>`];
  if (typeof body === 'string' && body.length > 0) textNodes.push(`<text>${escapeXml(body)}</text>`);
  for (const line of lines) textNodes.push(`<text>${escapeXml(line)}</text>`);

  const logo = typeof icon === 'string' && icon.length > 0
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(fileUri(icon))}"/>`
    : '';

  const actions = buttons.length === 0
    ? ''
    : '<actions>'
      + buttons.map((button) => {
        const style = typeof button.style === 'string' && button.style !== '' ? ` hint-button-style="${escapeXml(button.style)}"` : '';
        return `<action content="${escapeXml(button.content)}" arguments="${escapeXml(button.arguments)}" activationType="protocol"${style}/>`;
      }).join('')
      + '</actions>';

  const attributionNode = typeof attribution === 'string' && attribution.length > 0
    ? `<text placement="attribution">${escapeXml(attribution)}</text>`
    : '';

  const audio = silent
    ? '<audio silent="true"/>'
    : '<audio src="ms-winsoundevent:Notification.Default"/>';

  // tag / group 不是 toast XML 的子元素，只能作为 ToastNotification 的属性设置
  // （见 buildPowerShellScript 里的 $toast.Tag / $toast.Group）。
  void tag;
  void group;

  return `<toast ${rootAttributes}>`
    + '<visual><binding template="ToastGeneric">'
    + textNodes.join('')
    + logo
    + attributionNode
    + '</binding></visual>'
    + audio
    + actions
    + '</toast>';
}

/**
 * 生成发送一条 toast 的 PowerShell 脚本（纯 ASCII）。
 * @param {string} xmlBase64 toast XML 的 UTF-8 base64
 * @param {string} aumid AppUserModelID
 * @param {{tag?: string, group?: string, expiresInSeconds?: number, suppressPopup?: boolean}} meta
 * @returns {string} PowerShell 脚本
 */
export function buildPowerShellScript(xmlBase64, aumid, meta = {}) {
  const tag = safeTag(meta.tag);
  const group = typeof meta.group === 'string' && meta.group.length > 0 ? meta.group.slice(0, 64) : undefined;
  const seconds = Number(meta.expiresInSeconds);
  const expiring = Number.isFinite(seconds) && seconds > 0;
  return [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]',
    `$xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlBase64}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xmlText)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    tag !== undefined ? `$toast.Tag = '${tag.replace(/'/g, "''")}'` : '',
    group !== undefined ? `$toast.Group = '${group.replace(/'/g, "''")}'` : '',
    // DSH 在前台时「只进操作中心、不弹横幅」：不响铃、不打扰，也不给误点留机会，
    // 但操作中心里那条（以及它上面的按钮）照旧存在。
    meta.suppressPopup === true ? '$toast.SuppressPopup = $true' : '',
    // 到期即从屏幕与操作中心移除（这是「显示时间限制」真正的兜底：
    // duration 只决定横幅在屏幕上停多久，scenario=reminder 更是永不下屏）。
    expiring ? `$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds(${Math.round(seconds)})` : '',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid.replace(/'/g, "''")}').Show($toast)`,
    "Write-Output 'ok'",
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** UTF-16LE base64，供 powershell.exe -EncodedCommand 使用。 */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 本机是否具备发送 toast 的条件。 */
export function toastAvailability() {
  if (process.platform !== 'win32') return { available: false, reason: 'not-windows' };
  if (!existsSync(WINDOWS_POWERSHELL)) return { available: false, reason: 'no-windows-powershell' };
  return { available: true, reason: 'ok' };
}

/**
 * 跑一段 PowerShell（-EncodedCommand），返回成败。
 * @param {string} script - PowerShell 脚本
 * @param {number} [timeoutMs] - 超时
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function runPowerShell(script, timeoutMs = 15000) {
  const encoded = encodeCommand(script);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(
        WINDOWS_POWERSHELL,
        ['-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
    } catch (error) {
      finish({ ok: false, error: String(error?.message ?? error) });
      return;
    }

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2048);
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: 'powershell timeout' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(error?.message ?? error) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: stderr.trim() || `powershell exit ${String(code)}` });
    });
  });
}

/**
 * 发送一条 Windows 通知。
 * @param {object} options buildToastXml 的选项 + `{aumid?: string, timeoutMs?: number}`
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
export async function showWindowsToast(options) {
  const availability = toastAvailability();
  if (!availability.available) return { ok: false, skipped: availability.reason };

  const aumid = options.aumid ?? DEFAULT_AUMID;
  const xml = buildToastXml(options);
  const script = buildPowerShellScript(Buffer.from(xml, 'utf8').toString('base64'), aumid, options);
  return await runPowerShell(script, options.timeoutMs ?? 15000);
}

/**
 * 从操作中心移除一条已经发出的通知（按 tag + group 精确匹配）。
 * 用于「在别处已经回答了」时把带按钮的通知撤掉。
 * @param {{tag: string, group?: string, aumid?: string}} target
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function removeWindowsToast(target) {
  const tag = safeTag(target.tag);
  if (tag === undefined) return { ok: false, error: 'tag is required' };
  const group = typeof target.group === 'string' && target.group.length > 0 ? target.group.slice(0, 64) : 'dsh';
  const aumid = target.aumid ?? DEFAULT_AUMID;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    `[Windows.UI.Notifications.ToastNotificationManager]::History.Remove('${tag.replace(/'/g, "''")}', '${group.replace(/'/g, "''")}', '${aumid.replace(/'/g, "''")}')`,
    "Write-Output 'ok'",
  ].join('\n');
  return await runPowerShell(script, 8000);
}
