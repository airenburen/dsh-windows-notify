/**
 * 把 dsh-windows-notify 装进当前的桌面 profile：
 *   1. 备份 package.json / pnpm-lock.yaml / pnpm-workspace.yaml
 *   2. 用 DSH 自带的 pnpm 执行 `pnpm add link:<本目录>`（失败则退化为 junction）
 *   3. 把 dsh-windows-notify 追加进 package.json 的 dsh.profile.bundles
 *   4. 从 profile 目录里真正 import 一次这个包（提前暴露加载期错误）
 *   5. 跑插件自检 test/smoke.mjs
 *
 * 用法（需要能写 profile 目录的权限）：
 *   node tools/install-desktop.mjs [--dry-run] [--no-tests]
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const packageName = 'dsh-windows-notify';

const dryRun = process.argv.includes('--dry-run');
const skipTests = process.argv.includes('--no-tests');

const profileDir = process.env.DSH_PROFILE_DIR;
if (profileDir === undefined || profileDir === '') {
  console.error('DSH_PROFILE_DIR is not set; run this from a DSH session');
  process.exit(2);
}

const runtimeRoot = resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
const nodeExe = process.env.DSH_BUNDLED_NODE ?? join(runtimeRoot, 'node', 'bin', 'node.exe');
const pnpmEntry = process.env.DSH_BUNDLED_PNPM ?? join(runtimeRoot, 'pnpm', 'bin', 'pnpm.cjs');

const steps = [];
const report = (label, ok, detail) => {
  steps.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? profileDir,
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

console.log(`profile   : ${profileDir}`);
console.log(`plugin    : ${pluginDir}`);
console.log(`node      : ${nodeExe}${existsSync(nodeExe) ? '' : '  (缺失)'}`);
console.log(`pnpm      : ${pnpmEntry}${existsSync(pnpmEntry) ? '' : '  (缺失)'}`);
console.log(`bundle(s) : install ${dryRun ? '(dry-run)' : ''}`);

if (dryRun) {
  console.log('\n--dry-run: 不做任何修改');
  process.exit(0);
}

// 1) 备份 -------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(profileDir, `.backup-${packageName}-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  const from = join(profileDir, file);
  if (existsSync(from)) copyFileSync(from, join(backupDir, file));
}
report('备份 profile 配置', true, backupDir);

// 2) 安装依赖 ---------------------------------------------------------------
const linkedPath = join(profileDir, 'node_modules', packageName);
const declarePath = join(profileDir, 'package.json');
const declared = (() => {
  try {
    return JSON.parse(readFileSync(declarePath, 'utf8')).dependencies?.[packageName];
  } catch {
    return undefined;
  }
})();

let installed = existsSync(join(linkedPath, 'package.json'));
if (installed && declared !== undefined) {
  report('依赖已就绪', true, `package.json: ${declared}`);
} else if (existsSync(nodeExe) && existsSync(pnpmEntry)) {
  console.log('\n> pnpm add link:...');
  // minimumReleaseAge=0：pnpm 11 默认的「发布满一天才允许安装」供应链校验会拿
  // 既有 lockfile 里已装好的条目（本次操作无关）报错并中断收尾，这里只对本次
  // 安装关闭该校验；没有新增任何需要下载的包。
  const added = run(nodeExe, [pnpmEntry, 'add', `link:${pluginDir.replace(/\\/g, '/')}`, '--config.minimumReleaseAge=0', '--reporter=append-only']);
  installed = existsSync(join(linkedPath, 'package.json')) && JSON.parse(readFileSync(declarePath, 'utf8')).dependencies?.[packageName] !== undefined;
  report('pnpm add link:', installed, installed ? 'package.json + lockfile + node_modules 已一致' : `status=${added.status} ${added.stderr.trim().slice(0, 300)}`);
} else {
  report('pnpm add link:', false, '自带 pnpm 不存在，改用 junction 兜底');
}

if (!installed) {
  console.log('\n> 兜底：直接在 profile 的 node_modules 里建 junction');
  if (existsSync(linkedPath)) {
    installed = existsSync(join(linkedPath, 'package.json'));
    report('junction 安装', installed, '目录已存在，直接复用');
  } else {
    const made = run('cmd.exe', ['/c', 'mklink', '/J', linkedPath, pluginDir]);
    installed = made.status === 0 && existsSync(join(linkedPath, 'package.json'));
    report('junction 安装', installed, made.stderr.trim().slice(0, 300));
  }
}
if (!installed) {
  console.error('\n安装失败，未修改 profile 的 bundle 列表。备份在 ' + backupDir);
  process.exit(1);
}

// 3) bundle 列表 ------------------------------------------------------------
const packageJsonPath = join(profileDir, 'package.json');
const profileJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
profileJson.dsh ??= {};
profileJson.dsh.profile ??= {};
profileJson.dsh.profile.bundles ??= [];
const bundles = profileJson.dsh.profile.bundles;
if (!bundles.includes(packageName)) {
  bundles.push(packageName);
  writeFileSync(packageJsonPath, `${JSON.stringify(profileJson, null, 2)}\n`, 'utf8');
  report('写入 dsh.profile.bundles', true, `+ ${packageName}（共 ${bundles.length} 项）`);
} else {
  report('写入 dsh.profile.bundles', true, '已存在，跳过');
}

// 4) 真实 import 一次（提前暴露加载期错误）----------------------------------
console.log('\n> 从 profile 加载插件模块');
const loadScript = "const m = await import('dsh-windows-notify');"
  + " if (typeof m.apply !== 'function' || typeof m.Config !== 'function' || m.name !== 'windows-notify') { console.error('bad exports'); process.exit(1); }"
  + " console.log('exports ok:', Object.keys(m).join(','));";
const loadCheck = run(nodeExe, ['--input-type=module', '-e', loadScript], { capture: true });
const loadOk = loadCheck.status === 0;
report('模块可加载', loadOk, loadOk ? loadCheck.stdout.trim().split('\n').pop() : `${loadCheck.stdout.trim()} ${loadCheck.stderr.trim().slice(0, 400)}`);

// 5) 自检 -------------------------------------------------------------------
if (!skipTests) {
  for (const test of ['smoke.mjs', 'client.mjs']) {
    console.log(`\n> 运行 test/${test}`);
    const result = run(nodeExe, [join(linkedPath, 'test', test)], { capture: true });
    report(`test/${test}`, result.status === 0, result.status === 0 ? result.stdout.trim().split('\n').pop() : `${result.stdout.trim().slice(-400)} ${result.stderr.trim().slice(-400)}`);
    console.log(result.stdout.trim());
  }
}

const failed = steps.filter((step) => !step.ok);
console.log(`\n===== ${steps.length - failed.length}/${steps.length} 步成功 =====`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const step of failed) console.log(` - ${step.label}: ${step.detail ?? ''}`);
  process.exit(1);
}
console.log('完成。若 DSH 没有热加载到新插件，重启一次 DeepSeek Harness 即可。');
