/**
 * 「点通知回到 DSH」所依赖的自定义 URI 协议（默认 `dsh-notify:`）。
 *
 * 通知被点击时由系统（操作中心）执行协议处理器，所以这里在
 * `HKCU\Software\Classes\<scheme>\shell\open\command` 写一条命令：
 *
 *  - 桌面版 DSH（Electron）：命令就是 "DeepSeek Harness.exe"。
 *    该应用持有单实例锁，第二次启动会立刻把已有窗口 restore + focus 后退出，
 *    这正好等价于「回到 DSH」；应用没开时则顺带把 DSH 打开。
 *  - 浏览器模式（dsh web）：命令是一个只做 `start "" <web url>` 的小 .cmd，
 *    点击通知即用默认浏览器打开该会话页面。
 *
 * 全部写 HKCU，不需要管理员权限。
 *
 * @module dsh-windows-notify/protocol
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { WINDOWS_POWERSHELL } from './win-toast.js';

const REG_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');

/** 默认协议名。 */
export const DEFAULT_SCHEME = 'dsh-notify';

function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ code: -1, stdout, stderr: 'timeout' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 推断「点击通知后要唤起谁」。
 *
 * 判据只有一条：宿主进程的可执行文件是不是 node/node.exe。
 *  - 桌面端 DSH：Electron 以 Node 模式拉起宿主子进程，`process.execPath` 就是
 *    "DeepSeek Harness.exe"，它就是要点亮的窗口所属进程。
 *  - 浏览器模式（`dsh web` / npx 起）：execPath 是 node.exe，此时退回「用默认
 *    浏览器打开本会话地址」。
 *
 * 不能拿 ELECTRON_RUN_AS_NODE 当判据：DSH 给子进程（含它启动的终端）都带了这个
 * 环境变量，在一个继承该变量的 shell 里跑 node.exe 会被误判成桌面端。
 *
 * @returns {{kind: 'desktop', command: string, label: string}
 *   | {kind: 'browser', url: string, label: string}
 *   | {kind: 'none', label: string}}
 */
export function detectLauncher(env = process.env, execPath = process.execPath) {
  const path = String(execPath ?? '');
  const isNodeLike = /[\\/]node(\.exe)?$/i.test(path);
  if (path !== '' && !isNodeLike) {
    return { kind: 'desktop', command: `"${path}"`, label: path.split(/[\\/]/).pop() ?? path };
  }
  const url = typeof env.DSH_WEB_URL === 'string' && env.DSH_WEB_URL.length > 0 ? env.DSH_WEB_URL : undefined;
  if (url !== undefined) return { kind: 'browser', url, label: url };
  return { kind: 'none', label: path };
}

/** 浏览器模式的协议处理器脚本路径（首次需要时才会写入）。 */
function browserShimPath(home = process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.') {
  return join(home, 'dsh-windows-notify', 'open-dsh.cmd');
}

/** 写入（幂等）浏览器模式用的小 .cmd。 */
function ensureBrowserShim(url, home) {
  const path = browserShimPath(home);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `@echo off\r\nstart "" "${url}"\r\nexit /b 0\r\n`, 'utf8');
  return path;
}

/**
 * 按启动方式算出要写进注册表的命令。
 * @param {{kind: string, command?: string, url?: string}} launcher
 * @param {string} [home] LOCALAPPDATA 覆盖（测试用）
 * @returns {string | undefined} 可执行的命令行（含引号），无法处理时 undefined
 */
export function protocolCommandFor(launcher, home) {
  if (launcher.kind === 'desktop') return launcher.command;
  if (launcher.kind === 'browser') {
    const shim = ensureBrowserShim(launcher.url, home);
    return `"${shim}" %1`;
  }
  return undefined;
}

/** 桌面端 DSH 自己注册的协议（Electron setAsDefaultProtocolClient("dsh")）。 */
export const APP_SCHEME = 'dsh';

/** 桌面端应用协议里代表「把主窗口拉到前台」的地址。 */
export const APP_FOCUS_URI = 'dsh://open';

/**
 * 读一个协议当前注册的命令行（未注册返回 undefined）。
 * @param {string} scheme - 协议名（不含冒号）
 */
export async function readRegisteredCommand(scheme) {
  const result = await run(REG_EXE, ['query', `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`, '/ve']);
  if (result.code !== 0) return undefined;
  const match = /REG_SZ\s+(.*)$/m.exec(result.stdout);
  return match?.[1]?.trim();
}

/**
 * 决定「点击通知」要激活哪个 URI，并把必要的协议注册好。
 *
 *  - 桌面端：优先用应用自己注册的 `dsh:`（`dsh://open` 会被 Electron 的
 *    second-instance 处理成 restore + show + focus 主窗口），此时一个注册表
 *    字节都不用写；万一 `dsh:` 没注册，再退回到本插件自己的协议。
 *  - 浏览器模式：注册本插件协议，指向一个只做 `start "" <会话地址>` 的 .cmd。
 *
 * @param {{scheme?: string, launcher?: ReturnType<typeof detectLauncher>, home?: string, force?: boolean}} [options]
 * @returns {Promise<{ok: boolean, mode: 'app'|'self'|'none', uri?: string, command?: string,
 *   changed?: boolean, reason?: string, launcher: object}>}
 */
export async function resolveClickTarget(options = {}) {
  const scheme = options.scheme ?? DEFAULT_SCHEME;
  const launcher = options.launcher ?? detectLauncher();
  if (process.platform !== 'win32') return { ok: false, mode: 'none', reason: 'not-windows', launcher };

  if (launcher.kind === 'desktop') {
    const appCommand = await readRegisteredCommand(APP_SCHEME);
    if (appCommand !== undefined && appCommand !== '') {
      return { ok: true, mode: 'app', uri: APP_FOCUS_URI, command: appCommand, changed: false, launcher };
    }
    const registered = await ensureProtocolRegistered({ scheme, launcher, home: options.home, force: options.force });
    if (!registered.ok) return { ok: false, mode: 'none', reason: registered.reason, launcher };
    return { ok: true, mode: 'self', uri: `${scheme}:focus`, command: registered.command, changed: registered.changed, launcher };
  }

  if (launcher.kind === 'browser') {
    const registered = await ensureProtocolRegistered({ scheme, launcher, home: options.home, force: options.force });
    if (!registered.ok) return { ok: false, mode: 'none', reason: registered.reason, launcher };
    return { ok: true, mode: 'self', uri: `${scheme}:focus`, command: registered.command, changed: registered.changed, launcher };
  }

  return { ok: false, mode: 'none', reason: 'no-launcher', launcher };
}

/**
 * 幂等写一个协议的处理命令（HKCU，无需管理员）。
 * @param {string} scheme - 协议名
 * @param {string} command - shell\open\command 的命令行
 * @param {boolean} [force] - 即使已一致也重写
 * @returns {Promise<{ok: boolean, changed: boolean, command?: string, reason?: string}>}
 */
export async function writeProtocolCommand(scheme, command, force = false) {
  const current = await readRegisteredCommand(scheme);
  if (!force && current === command) return { ok: true, changed: false, command };

  const base = `HKCU\\Software\\Classes\\${scheme}`;
  const steps = [
    ['add', base, '/ve', '/t', 'REG_SZ', '/d', 'URL:DSH Notification Protocol', '/f'],
    ['add', base, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['add', `${base}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ];
  for (const args of steps) {
    const result = await run(REG_EXE, args);
    if (result.code !== 0) {
      return { ok: false, changed: false, command, reason: result.stderr.trim() || `reg exit ${String(result.code)}` };
    }
  }
  return { ok: true, changed: true, command };
}

/**
 * 幂等注册协议处理器。
 * @param {{scheme?: string, launcher?: ReturnType<typeof detectLauncher>, home?: string, force?: boolean}} [options]
 * @returns {Promise<{ok: boolean, changed: boolean, command?: string, reason?: string}>}
 */
export async function ensureProtocolRegistered(options = {}) {
  if (process.platform !== 'win32') return { ok: false, changed: false, reason: 'not-windows' };
  const scheme = options.scheme ?? DEFAULT_SCHEME;
  const launcher = options.launcher ?? detectLauncher();
  const command = protocolCommandFor(launcher, options.home);
  if (command === undefined) return { ok: false, changed: false, reason: 'no-launcher' };
  return await writeProtocolCommand(scheme, command, options.force === true);
}

/** 「允许 / 拒绝」按钮回传脚本的路径。 */
export function decisionShimPath(home = process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.') {
  return join(home, 'dsh-windows-notify', 'decision.ps1');
}

/** 按钮激活审计日志的路径（谁在什么时候点了哪个按钮）。 */
export function decisionLogPath(home = process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.') {
  return join(home, 'dsh-windows-notify', 'decision.log');
}

/**
 * 生成按钮回传脚本（纯 ASCII，PS 5.1 不带 BOM 也安全）。
 *
 * 通知按钮只能激活一个 URI，所以这里把 `dsh-notify:allow/<token>` 翻译成
 * 一次对本机 DSH 回环接口的 POST：
 *   POST <base>/plugins/dsh-windows-notify/decision?token=<token>&choice=allow
 *
 * 每次激活还会往 `decision.log` 追加一行审计：时间 / choice / token / **拉起它的父进程**。
 * 父进程能区分「人点的通知」（explorer / ShellExperienceHost）和「别的程序调 Start-Process」
 * （powershell / node …），排查「按钮怎么自己响应了」时非常有用。先 POST 再记日志，
 * 免得 WMI 查询拖慢结算。
 *
 * @param {string} base - DSH Web 地址（宿主自己的回环地址）
 * @returns {string} PowerShell 脚本
 */
export function decisionScript(base) {
  return [
    'param([string]$Uri)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$Base = '${String(base).replace(/'/g, "''")}'`,
    "$raw = $Uri -replace '^dsh-notify:', ''",
    "$parts = $raw -split '/', 2",
    '$choice = $parts[0]',
    "$token = if ($parts.Length -gt 1) { $parts[1] } else { '' }",
    "$url = $Base + '/plugins/dsh-windows-notify/decision?token=' + $token + '&choice=' + $choice",
    'try { Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 5 | Out-Null } catch { }',
    'try {',
    '  $me = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID)',
    '  $parent = if ($me) { Get-CimInstance Win32_Process -Filter ("ProcessId = " + $me.ParentProcessId) } else { $null }',
    "  $who = if ($parent) { $parent.Name } else { '?' }",
    "  $cmd = if ($parent -and $parent.CommandLine) { $parent.CommandLine.Substring(0, [Math]::Min(120, $parent.CommandLine.Length)) } else { '' }",
    "  $line = (Get-Date).ToString('o') + ' | ' + $choice + ' | ' + $token + ' | ' + $who + ' | ' + $cmd",
    "  $log = Join-Path $env:LOCALAPPDATA 'dsh-windows-notify\\decision.log'",
    '  Add-Content -Path $log -Value $line -Encoding UTF8',
    '  if ((Get-Item $log).Length -gt 65536) { Get-Content $log | Select-Object -Last 100 | Set-Content $log -Encoding UTF8 }',
    '} catch { }',
  ].join('\r\n');
}

/**
 * 注册「点通知里的允许 / 拒绝按钮」用的协议：命令启动一个隐藏的 PowerShell
 * 跑回传脚本。这条通道独立于「点击回到 DSH」用的 `dsh:`，所以必须单独注册。
 *
 * @param {{base?: string, scheme?: string, home?: string, force?: boolean, powershell?: string}} [options]
 * @returns {Promise<{ok: boolean, changed?: boolean, command?: string, script?: string, reason?: string}>}
 */
export async function ensureDecisionProtocol(options = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-windows' };
  const base = options.base ?? process.env.DSH_WEB_URL;
  if (typeof base !== 'string' || base === '') return { ok: false, reason: 'no-web-url' };
  const scheme = options.scheme ?? DEFAULT_SCHEME;
  const scriptPath = decisionShimPath(options.home);
  mkdirSync(join(scriptPath, '..'), { recursive: true });
  writeFileSync(scriptPath, decisionScript(base), 'utf8');
  const powershell = options.powershell ?? WINDOWS_POWERSHELL;
  const command = `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}" "%1"`;
  const result = await writeProtocolCommand(scheme, command, options.force === true);
  return { ...result, script: scriptPath };
}
