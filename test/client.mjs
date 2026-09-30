/**
 * 客户端半边（lib/client.js）的自检：不需要浏览器、也不需要真的 React。
 *
 * 用一个可编排的假 React（createElement / useState / useEffect / useCallback）
 * + 假 window.__ModuleLoader__ + 假 ctx 把 bundle 跑起来，验证：
 *   - bundle 是 dsh-client-modules 要求的格式，factory 交出 apply/inject；
 *   - **有 DSH-better-sidebar 时**：设置搬进它的设置页（registerTab + settings.render，
 *     hidden:true 不给「+」菜单添乱），插件行配置页被撤掉；
 *   - **没有 better-sidebar 时**：退回插件行配置页（plugins.row.config）；
 *   - 设置面板在「读取中 / 读取失败 / 读取成功」三态下的渲染，拨开关发出的 ops；
 *   - 「发送测试通知」按钮与失败反馈、「重试」；
 *   - tab 本体（状态 + 最近通知）能渲染。
 *
 * 用法：node test/client.mjs
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- 假 React
let scriptedState;
let stateCursor = 0;
const effects = [];
let updates = [];
const recordUpdate = (updater) => {
  updates.push(updater);
};

function createElement(type, props, ...children) {
  if (props !== undefined && props !== null && typeof props !== 'object') throw new Error('createElement props must be an object or null');
  if (props?.style !== undefined && (typeof props.style !== 'object' || props.style === null)) throw new Error('style must be an object');
  const flat = children.length === 1 ? children[0] : children;
  return { type, props: { ...(props ?? {}), children: flat } };
}

const fakeReact = {
  createElement,
  useState(initial) {
    if (stateCursor === 0 && scriptedState !== undefined) {
      stateCursor += 1;
      return [scriptedState, recordUpdate];
    }
    stateCursor += 1;
    return [initial, recordUpdate];
  },
  useEffect(callback) {
    effects.push(callback);
  },
  useCallback(callback) {
    return callback;
  },
};

// ------------------------------------------------- 假 __ModuleLoader__ 与 require
let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

const requireCalls = [];
function fakeRequire(name) {
  requireCalls.push(name);
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require("${name}")`);
}

await import('../lib/client.js');

assert.ok(captured !== undefined, 'bundle 应调用 window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-windows-notify', 'bundle id 必须是包名');
assert.equal(typeof captured.factory, 'function');
const clientModule = captured.factory(fakeRequire);
assert.equal(typeof clientModule.apply, 'function');
assert.deepEqual(clientModule.inject, ['slots']);
assert.deepEqual(requireCalls, ['react'], '只应 require react');
ok('bundle 格式与 factory 导出（apply / inject = [slots]）');

// ---------------------------------------------------------------- 假客户端 ctx
function makeClientCtx({ withBetterSidebar, uiSession }) {
  const rowPages = [];
  const registrations = [];
  const disposed = [];
  const tabs = [];
  let currentSlot;
  const ctx = {
    slots: {
      inject(name, callback) {
        currentSlot = name;
        try {
          return callback();
        } finally {
          currentSlot = undefined;
        }
      },
      register(definition, component) {
        const record = { slot: definition.name ?? currentSlot, definition, component };
        registrations.push(record);
        if (record.slot === 'plugins.row.config') rowPages.push(record);
        return () => {
          disposed.push(definition.key ?? definition.id);
        };
      },
    },
    effect(callback) {
      return callback();
    },
    inject(deps, callback) {
      const missing = deps.filter((name) => {
        if (name === 'betterSidebar') return ctx.betterSidebar === undefined;
        if (name === 'uiSession') return ctx.uiSession === undefined;
        return false;
      });
      if (missing.length > 0) return () => {};
      callback(ctx);
      return () => {};
    },
  };
  if (withBetterSidebar === true) {
    ctx.betterSidebar = {
      registerTab(descriptor) {
        tabs.push(descriptor);
        return () => {};
      },
    };
  }
  if (uiSession !== undefined) ctx.uiSession = uiSession;
  return { ctx, rowPages, registrations, disposed, tabs };
}

// --------------------------------------------------- 有 better-sidebar：搬过去
const applyCalls = [];
globalThis.fetch = async (url, options = {}) => {
  applyCalls.push({ url, method: options.method ?? 'GET' });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const withSidebar = makeClientCtx({ withBetterSidebar: true });
clientModule.apply(withSidebar.ctx);
assert.deepEqual(applyCalls, [{ url: '/plugins/dsh-windows-notify/hello', method: 'POST' }], 'apply 时应 ping 一次');
ok('apply 时 ping /hello（宿主靠它得知自己的监听地址，按钮回传脚本要用）');
assert.equal(withSidebar.rowPages.length, 1, '先注册兜底行配置页');
assert.equal(withSidebar.rowPages[0].definition.key, 'dsh-windows-notify#windows-notify');
assert.deepEqual(withSidebar.disposed, ['dsh-windows-notify#windows-notify'], '有 better-sidebar 时撤掉行配置页');
assert.equal(withSidebar.tabs.length, 1, '注册到 better-sidebar 的 tab 表');
const tab = withSidebar.tabs[0];
assert.equal(tab.id, 'dsh-windows-notify');
assert.equal(tab.hidden, true, 'hidden：不给 DSH 原生「+」菜单添乱，但设置卡片照常出现');
assert.equal(tab.order, 900);
assert.equal(typeof tab.title, 'function');
assert.equal(typeof tab.title(), 'string');
assert.equal(typeof tab.description, 'function');
assert.equal(typeof tab.settings?.render, 'function', '齿轮里的自定义面板由 settings.render 提供');
assert.equal(typeof tab.component, 'function');
ok('有 better-sidebar：设置搬进它的设置页（registerTab + settings.render），行配置页被撤下');

// ------------------------- 原生设置页：设置 → 左侧导航多一格「通知」（同 dsh-market）
{
  const section = withSidebar.registrations.find((item) => item.slot === 'settings.section');
  assert.ok(section !== undefined, '应注册一格 settings.section');
  assert.equal(section.definition.id, 'dsh-windows-notify', '用自己的 id（复用别人的会顶掉对方那一页）');
  assert.equal(section.definition.order, 55, '排在插件市场 (40) 之后');
  assert.equal(typeof section.definition.label, 'function');
  assert.ok(['通知', 'Notifications'].includes(section.definition.label()), `导航文案应是本地化的，实际 ${section.definition.label()}`);

  const rendered = renderElement(section.component({ close: () => {} }), { status: 'ready', value: { enabled: true }, revision: 1, error: undefined, busy: false, note: undefined });
  const renderedJson = JSON.stringify(rendered);
  assert.equal(renderedJson.includes('发送测试通知') || renderedJson.includes('Send test toast'), true, '是同一块配置面板');
  assert.equal(renderedJson.includes('Windows 通知') || renderedJson.includes('Windows notifications'), true, '整页形态带标题');
  ok('原生设置页：settings.section 注册（id/order/label + 渲染配置面板）');
}
{
  // 没有 better-sidebar 时，原生设置页照样要在
  const fallback = makeClientCtx({ withBetterSidebar: false });
  clientModule.apply(fallback.ctx);
  assert.ok(fallback.registrations.some((item) => item.slot === 'settings.section'), '不依赖 better-sidebar');
  assert.equal(fallback.rowPages.length, 1, '行配置页也保留');
  ok('原生设置页不依赖 better-sidebar；行配置页作为兜底仍在');
}

// ------------------------------------------------- 没有 better-sidebar：兜底
{
  const fallback = makeClientCtx({ withBetterSidebar: false });
  clientModule.apply(fallback.ctx);
  assert.equal(fallback.rowPages.length, 1, '没有 better-sidebar 时保留行配置页');
  assert.equal(fallback.disposed.length, 0);
  assert.equal(fallback.tabs.length, 0);
  ok('没有 better-sidebar：退回插件行配置页');
}

// ---------------------------------------------------------------- 渲染工具
function renderElement(element, state) {
  scriptedState = state;
  stateCursor = 0;
  effects.length = 0;
  updates = [];
  const items = [];
  const fields = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      items.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node.type === 'function') {
      if (node.type.name === 'Field') {
        fields.push(node.props);
        return;
      }
      walk(node.type(node.props));
      return;
    }
    items.push({ type: node.type, props: node.props });
    walk(node.props?.children);
  })(element);
  return { items, fields };
}

const texts = (items) => items.filter((item) => typeof item === 'string').join(' | ');
const nodes = (items, type) => items.filter((item) => typeof item === 'object' && item.type === type);
const childrenOf = (items, type, label) => nodes(items, type).find((node) => node.props.children === label);

const CONFIG_VALUE = {
  enabled: true,
  notifyApproval: true,
  notifyQuestion: true,
  notifyTurnEnd: false,
  notifyError: true,
  agentTool: true,
  httpApi: true,
  focusOnClick: true,
  sound: true,
  sticky: false,
  displaySeconds: 10,
  decisionButtons: true,
  decisionSeconds: 300,
  decisionButtonsFor: 'safe-only',
  whenFocused: 'silent',
  language: 'zh',
  aumid: 'com.deepseek.dsh',
  dedupeMs: 4000,
  maxPerMinute: 20,
  debugLog: false,
};
const READY_STATE = { status: 'ready', value: CONFIG_VALUE, revision: 7, error: undefined, busy: false, note: undefined };
const ALL_KEYS = ['agentTool', 'aumid', 'debugLog', 'decisionButtons', 'decisionButtonsFor', 'decisionSeconds', 'dedupeMs', 'displaySeconds', 'enabled', 'focusOnClick', 'httpApi', 'language', 'maxPerMinute', 'notifyApproval', 'notifyError', 'notifyQuestion', 'notifyTurnEnd', 'sound', 'sticky', 'whenFocused'];

/** better-sidebar 齿轮里的那个面板。 */
const renderSidebarPanel = (state) => renderElement(tab.settings.render({ pluginSettings: {}, updatePluginSetting: () => {}, close: () => {} }), state);
/** 兜底行配置页。 */
const renderRowPage = (state) => renderElement(withSidebar.rowPages[0].component({}), state);

// ------------------------------------------------- 行配置页：summary 与三态
{
  const summary = withSidebar.rowPages[0].component({ view: 'summary' });
  assert.equal(typeof summary, 'string');
  assert.match(summary, /Windows 系统通知/);
  ok('summary 视图返回一句话');
}
{
  const { items, fields } = renderRowPage({ status: 'loading', value: undefined, revision: undefined, error: undefined, busy: false, note: undefined });
  assert.match(texts(items), /正在读取配置/);
  assert.equal(effects.length, 1, '挂载时注册一次 useEffect（首次读取）');
  assert.equal(fields.length, 0);
  ok('行配置页：读取中状态可渲染');
}
{
  const { items } = renderRowPage({ status: 'error', error: 'boom', value: undefined, revision: undefined, busy: false, note: undefined });
  assert.match(texts(items), /读取配置失败/);
  assert.ok(childrenOf(items, 'button', '重试') !== undefined, '失败时应给出「重试」');
  ok('行配置页：读取失败显示错误与「重试」');
}

// ------------------------------------------- better-sidebar 面板：字段与写入
{
  const { items, fields } = renderSidebarPanel(READY_STATE);
  assert.equal(fields.length, ALL_KEYS.length, `面板应有 ${ALL_KEYS.length} 个字段，实际 ${fields.length}`);
  assert.deepEqual(fields.map((field) => field.field.key).sort(), [...ALL_KEYS].sort());
  assert.ok(childrenOf(items, 'button', '发送测试通知') !== undefined);
  assert.match(texts(items), /通知场景/);
  assert.match(texts(items), /10s/, '摘要里带上显示时间限制');
  const displayField = fields.find((field) => field.field.key === 'displaySeconds');
  assert.equal(displayField.field.type, 'number');
  assert.equal(displayField.value, 10);
  assert.equal(displayField.field.label[0], '显示时间限制（秒）');
  ok(`better-sidebar 面板：${ALL_KEYS.length} 个字段 + 测试按钮（含显示时间限制）`);
}
{
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ns: 'windows-notify', value: { ...CONFIG_VALUE, notifyTurnEnd: true }, revision: 8 }),
    };
  };
  const { fields } = renderSidebarPanel(READY_STATE);
  const toggle = fields.find((field) => field.field.key === 'notifyTurnEnd');
  toggle.onChange(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const post = calls.find((call) => call.method === 'POST');
  assert.ok(post !== undefined, '应发出一次 POST');
  assert.equal(post.url, '/plugins/dsh-windows-notify/config');
  assert.deepEqual(post.body, { ops: [{ op: 'set', path: ['notifyTurnEnd'], value: true }], expectedRevision: 7 });
  ok('面板拨动开关 → POST ops + expectedRevision');
}
{
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, delivered: true }) };
  };
  const { items } = renderSidebarPanel(READY_STATE);
  const testButton = childrenOf(items, 'button', '发送测试通知');
  await testButton.props.onClick();
  assert.equal(calls[0].url, '/plugins/dsh-windows-notify/send');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.tag, 'dsh-settings-test');
  ok('「发送测试通知」调用 /send');
}
{
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'powershell 起不来' }) });
  const { items } = renderSidebarPanel(READY_STATE);
  const testButton = childrenOf(items, 'button', '发送测试通知');
  await testButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const merged = updates.reduce((state, updater) => (typeof updater === 'function' ? updater(state) : updater), READY_STATE);
  assert.match(String(merged.error), /powershell 起不来/, '失败应写进面板状态');
  ok('发送失败：错误进入面板状态而不是静默');
}
{
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({ ok: true, ns: 'windows-notify', value: CONFIG_VALUE, revision: 9 }) };
  };
  const { items } = renderSidebarPanel({ status: 'error', error: 'boom', value: undefined, revision: undefined, busy: false, note: undefined });
  const retry = childrenOf(items, 'button', '重试');
  await retry.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0].url, '/plugins/dsh-windows-notify/config');
  assert.equal(calls[0].method, 'GET');
  ok('「重试」重新读取配置');
}

// ------------------------------------------------------------ tab 本体渲染
{
  globalThis.fetch = async (url) => {
    if (url.endsWith('/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, available: true, aumid: 'com.deepseek.dsh', click: { ok: true, mode: 'app', uri: 'dsh://open' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, items: [{ ts: Date.now(), title: '示例通知', body: '正文', ok: true }] }) };
  };
  const { items } = renderElement(tab.component(), {
    status: 'ready',
    info: { available: true, aumid: 'com.deepseek.dsh', click: { ok: true, mode: 'app', uri: 'dsh://open' } },
    items: [{ ts: Date.now(), title: '示例通知', body: '正文', ok: true }],
    error: undefined,
    busy: false,
    note: undefined,
  });
  assert.match(texts(items), /通知通道/);
  assert.match(texts(items), /com\.deepseek\.dsh/);
  assert.match(texts(items), /示例通知/);
  assert.match(texts(items), /侧边栏卡片/, '应指引用户去 better-sidebar 的设置页');
  ok('tab 本体：状态 / 最近通知 / 设置位置指引');
}
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return url.endsWith('/status')
      ? { ok: true, status: 200, json: async () => ({ ok: true, available: true }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };
  };
  renderElement(tab.component(), { status: 'loading', info: undefined, items: [], error: undefined, busy: false, note: undefined });
  assert.equal(effects.length, 1);
  await effects[0]();
  assert.deepEqual(calls, ['/plugins/dsh-windows-notify/status', '/plugins/dsh-windows-notify/recent']);
  ok('tab 本体：挂载时读 /status 与 /recent');
}

// --------------------------------- 从通知按钮结算 → 收掉 GUI 那张还挂着的审批卡
{
  // A 路线：uiSession 的 pending 投影里那个实例带公开 answer()，直接结算它。
  const answers = [];
  const interaction = {
    kind: 'approval',
    answerable: true,
    answer(outcome) {
      answers.push(outcome);
      return Promise.resolve();
    },
  };
  const snapshot = new Map([['session-1', { pendingInteraction: interaction }]]);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).includes('/decisions')) {
      const incremental = String(url).includes('since=');
      return {
        ok: true,
        status: 200,
        json: async () => (incremental
          ? { ok: true, seq: 5, items: [{ seq: 5, sessionId: 'session-1', outcome: 'allowed-once', toolName: 'pwsh' }] }
          : { ok: true, seq: 4, items: [] }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const made = makeClientCtx({ withBetterSidebar: true, uiSession: { sessionStatus: { getSnapshot: () => snapshot } } });
  clientModule.apply(made.ctx);
  assert.equal(typeof clientModule.__decisionTick, 'function', '应暴露自检用的 tick');

  await clientModule.__decisionTick();
  assert.deepEqual(answers, [], '第一次只对齐基线：不能凭上一次的旧事实去点新卡片');
  assert.ok(calls.some((call) => call.url.includes('/decisions') && !call.url.includes('since')), '首次只取 seq');

  await clientModule.__decisionTick();
  assert.deepEqual(answers, ['allowed-once'], '第二次按增量结算那个 pending 审批');
  ok('A 路线：宿主报「已从通知允许」→ 直接 answer 掉 pending 审批（卡片随之消失）');
}
{
  // 拒绝同样走 A
  const answers = [];
  const interaction = { kind: 'approval', answerable: true, answer: (outcome) => { answers.push(outcome); return Promise.resolve(); } };
  const snapshot = new Map([['session-9', { pendingInteraction: interaction }]]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/decisions')) {
      return String(url).includes('since=')
        ? { ok: true, status: 200, json: async () => ({ ok: true, seq: 2, items: [{ seq: 2, sessionId: 'session-9', outcome: 'rejected' }] }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, seq: 1, items: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const made = makeClientCtx({ withBetterSidebar: true, uiSession: { sessionStatus: { getSnapshot: () => snapshot } } });
  clientModule.apply(made.ctx);
  await clientModule.__decisionTick();
  await clientModule.__decisionTick();
  assert.deepEqual(answers, ['rejected']);
  ok('A 路线：「已从通知拒绝」→ 以 rejected 结算');
}
{
  // B 兜底：实例已经结算过（answer 抛 already settled）→ 按文案点卡上的按钮
  const clicks = [];
  const card = {
    textContent: '等待审批 允许本次操作使用 danger-full-access 权限：…',
    parentElement: null,
  };
  const button = {
    textContent: '允许一次',
    disabled: false,
    getAttribute: () => null,
    click: () => clicks.push('allowed-once'),
    parentElement: card,
  };
  globalThis.document = { querySelectorAll: (selector) => (selector === 'button' ? [button] : []) };
  const interaction = { kind: 'approval', answerable: true, answer: () => { throw new Error('already settled'); } };
  const snapshot = new Map([['session-2', { pendingInteraction: interaction }]]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/decisions')) {
      return String(url).includes('since=')
        ? { ok: true, status: 200, json: async () => ({ ok: true, seq: 3, items: [{ seq: 3, sessionId: 'session-2', outcome: 'allowed-once' }] }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, seq: 2, items: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const made = makeClientCtx({ withBetterSidebar: true, uiSession: { sessionStatus: { getSnapshot: () => snapshot } } });
  clientModule.apply(made.ctx);
  await clientModule.__decisionTick();
  await clientModule.__decisionTick();
  assert.deepEqual(clicks, ['allowed-once'], 'A 抛错时应该退到 DOM 点按钮');
  delete globalThis.document;
  ok('B 兜底：拿不到可结算的实例时，按文案点审批卡上的「允许一次」');
}
{
  // B 的匹配规则：不在审批卡里的同名按钮不点；禁用的不点
  const clicks = [];
  const outsideCard = {
    textContent: '允许一次',
    disabled: false,
    getAttribute: () => null,
    click: () => clicks.push('outside'),
    parentElement: { textContent: '别的面板', parentElement: null },
  };
  const disabled = {
    textContent: '拒绝',
    disabled: true,
    getAttribute: () => null,
    click: () => clicks.push('disabled'),
    parentElement: { textContent: '等待审批', parentElement: null },
  };
  const good = {
    textContent: '拒绝',
    disabled: false,
    getAttribute: () => null,
    click: () => clicks.push('rejected'),
    parentElement: { textContent: '等待审批', parentElement: null },
  };
  globalThis.document = { querySelectorAll: () => [outsideCard, disabled, good] };
  const answers = [];
  const interaction = { kind: 'approval', answerable: false, answer: (outcome) => { answers.push(outcome); return Promise.resolve(); } };
  const snapshot = new Map([['session-3', { pendingInteraction: interaction }]]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/decisions')) {
      return String(url).includes('since=')
        ? { ok: true, status: 200, json: async () => ({ ok: true, seq: 9, items: [{ seq: 9, sessionId: 'session-3', outcome: 'rejected' }] }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, seq: 8, items: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const made = makeClientCtx({ withBetterSidebar: true, uiSession: { sessionStatus: { getSnapshot: () => snapshot } } });
  clientModule.apply(made.ctx);
  await clientModule.__decisionTick();
  await clientModule.__decisionTick();
  assert.deepEqual(clicks, ['rejected'], '只点审批卡里、未被禁用、文案匹配的那个按钮');
  delete globalThis.document;
  ok('B 兜底：只点审批卡内的匹配按钮，跳过禁用项与别的面板');
}
{
  // 空闲（本地没有待审批）时不打扰宿主
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, seq: 0, items: [] }) };
  };
  const snapshot = new Map([['session-4', { pendingInteraction: { kind: 'question' } }]]);
  const made = makeClientCtx({ withBetterSidebar: true, uiSession: { sessionStatus: { getSnapshot: () => snapshot } } });
  clientModule.apply(made.ctx);
  await clientModule.__decisionTick();
  await clientModule.__decisionTick();
  assert.equal(calls.some((url) => url.includes('/decisions')), false, '没有待审批就不轮询');
  ok('没有待审批时不轮询宿主（空闲零开销）');
}

// --------------------------------------- 前后台上报（宿主据此决定前台是否静默）
{
  const listeners = new Map();
  let focused = true;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  globalThis.document = {
    visibilityState: 'visible',
    hasFocus: () => focused,
    addEventListener: (name, handler) => listeners.set(`doc:${name}`, handler),
  };
  globalThis.window = { addEventListener: (name, handler) => listeners.set(`win:${name}`, handler) };

  const focusCalls = () => calls.filter((call) => call.url.endsWith('/focus'));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const made = makeClientCtx({ withBetterSidebar: true });
  clientModule.apply(made.ctx);
  await flush();
  assert.equal(focusCalls().length, 1, '载入时先报一次当前焦点');
  assert.equal(focusCalls()[0].body.focused, true);
  assert.equal(typeof focusCalls()[0].body.windowId, 'string');
  assert.ok(focusCalls()[0].body.windowId.length > 0);
  ok('前后台：载入时上报一次（focused=true，带 windowId）');

  focused = false;
  listeners.get('win:blur')();
  await flush();
  assert.equal(focusCalls().at(-1).body.focused, false);
  ok('前后台：失焦（blur）立刻上报 focused=false');

  focused = true;
  globalThis.document.visibilityState = 'hidden';
  listeners.get('doc:visibilitychange')();
  await flush();
  assert.equal(focusCalls().at(-1).body.focused, false, '最小化/隐藏算后台');
  ok('前后台：visibilitychange（最小化）也算后台');

  // 状态没变时不重复发（省流量），心跳则强制续期（宿主 45 秒 TTL 靠它）
  const before = focusCalls().length;
  listeners.get('win:focus')();
  await flush();
  assert.equal(focusCalls().length, before, '状态没变不发重复请求');
  clientModule.__focusReport(true);
  await flush();
  assert.equal(focusCalls().length, before + 1, '心跳强制续期');
  ok('前后台：状态不变不刷请求，心跳负责续期');

  delete globalThis.window;
  delete globalThis.document;
}

console.log(`\n${passed} checks passed.`);
