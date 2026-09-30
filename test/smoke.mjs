/**
 * 插件宿主半边的行为自检：用一个假 ctx 驱动 apply()，验证
 *   - 权限请求 / 提问 / 一轮结束 / 出错 四类状态各自会不会发通知；
 *   - 去重、限流、开关、点击回到 DSH 的目标解析是否生效；
 *   - notify_user 工具定义、execute、render 是否可用；
 *   - HTTP /send 与 /status 路由的入参与返回；
 *   - 通知通道故障时只降级，不影响批准流程与会话。
 *
 * 运行（需要在能解析 @deepseek-ai/* 的目录下，例如本目录已就位的 node_modules
 * 联接，或装到 profile 后的 node_modules/dsh-windows-notify/test/smoke.mjs）：
 *   node test/smoke.mjs
 * 纯 Windows 侧（发真通知）自检见 test/windows.mjs。
 */

import assert from 'node:assert/strict';

const { apply, Config, name, isForegroundReport } = await import('../lib/index.js');
const { isPrivilegedApproval } = await import('../lib/messages.js');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** 假 ctx：记录事件监听、路由、工具注册。服务同时挂在属性上（与真 ctx 一致）。 */
function makeCtx() {
  const handlers = new Map();
  const routes = [];
  const tools = [];
  const services = new Map();
  const effects = [];
  const warnings = [];
  const toolsService = { register: (definition) => { tools.push(definition); return () => {}; } };
  const webServerService = { register: (route) => { routes.push(route); return () => {}; } };
  const settingsState = { value: { enabled: true, notifyTurnEnd: false, language: 'zh' }, revision: 7, calls: [] };
  const settingsService = {
    describe: () => [
      { ns: 'something-else', value: {}, revision: 1 },
      { ns: 'windows-notify', value: settingsState.value, revision: settingsState.revision },
    ],
    mutate: async (ns, ops, expectedRevision) => {
      settingsState.calls.push({ ns, ops, expectedRevision });
      for (const op of ops) {
        if (op.op === 'set' && Array.isArray(op.path) && op.path.length === 1) settingsState.value[op.path[0]] = op.value;
      }
      settingsState.revision += 1;
    },
  };
  const named = new Map([
    ['tools', toolsService],
    ['webServer', webServerService],
    ['settings', settingsService],
  ]);
  const ctx = {
    tools: toolsService,
    webServer: webServerService,
    settings: settingsService,
    logger: {
      info: () => {},
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    get(service) {
      return named.get(service);
    },
    set(service, value) {
      services.set(service, value);
    },
    /** 真 ctx 的注入语义：依赖齐了就立刻回调（这里简化为立即回调）。 */
    inject(deps, callback) {
      const missing = deps.filter((name) => named.get(name) === undefined);
      if (missing.length > 0) throw new Error(`fake ctx missing services: ${missing.join(',')}`);
      callback(ctx);
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, handlers, routes, tools, services, warnings, effects, settingsState };
}

/** 假配置：全部按 volatile 引用的形态提供。 */
function volatileConfig(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) out[key] = { get: () => value };
  return out;
}

/** 桌面端可用的点击目标。 */
const APP_TARGET = { ok: true, mode: 'app', uri: 'dsh://open', changed: false };

/** 假 req/res。 */
function makeExchange(method, body, options = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = {
    method,
    socket: {
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
      localAddress: options.localAddress ?? '127.0.0.1',
      localPort: options.localPort ?? 19387,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  const captured = { status: 0, headers: undefined, body: undefined };
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(payload) {
      captured.body = payload;
    },
  };
  return { req, res, captured };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 模拟页面加载时客户端半边那次 /hello ping：让宿主从 socket 上学到自己的地址。 */
async function learnOrigin(made) {
  const exchange = makeExchange('POST');
  const route = made.routes.find((item) => item.path.endsWith('/hello'));
  await route.handler(exchange.req, exchange.res);
  await settle();
  return exchange;
}

/**
 * 工具结果必须**逐字段**落在它自己声明的 output.schema 里：
 * 注册表用 additionalProperties:false 校验，多一个键就是「工具返回非法输出」。
 */
function assertAllKeysDeclared(label, tool, value) {
  const declared = new Set(Object.keys(tool.output.schema.properties));
  const extra = Object.keys(value).filter((key) => !declared.has(key));
  assert.deepEqual(extra, [], `${label} 出现了 schema 未声明的字段（注册表会拒绝）`);
  const missing = [...declared].filter((key) => tool.output.schema.required?.includes(key) && value[key] === undefined);
  assert.deepEqual(missing, [], `${label} 缺少必填字段`);
  for (const key of Object.keys(value)) {
    assert.notEqual(value[key], undefined, `${label}.${key} 不能是 undefined（要求 lossless JSON）`);
  }
}

// ---------------------------------------------------------------- 基本导出
assert.equal(name, 'windows-notify');
assert.equal(typeof apply, 'function');
assert.equal(typeof Config, 'function');
const configFields = Object.keys(Config({}));
assert.ok(configFields.includes('notifyApproval') && configFields.includes('aumid'));
ok('模块导出 name / Config / apply');

// -------------------------------------------------------- 四类状态的通知行为
{
  const sent = [];
  const targets = [];
  const { ctx, handlers, routes, tools, services, warnings } = makeCtx();
  const config = volatileConfig({ notifyTurnEnd: false, dedupeMs: 0, maxPerMinute: 100 });
  apply(ctx, config, {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async (options) => { targets.push(options); return APP_TARGET; },
    detectLauncher: () => ({ kind: 'desktop', command: '"D:\\DSH\\DeepSeek Harness.exe"', label: 'DeepSeek Harness.exe' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });

  assert.ok(handlers.has('approval/request'), '注册了 approval/request');
  assert.ok(handlers.has('user-questions/request'), '注册了 user-questions/request');
  assert.ok(handlers.has('agent/turn-stopping'));
  assert.ok(handlers.has('agent/error'));

  let nextCalled = 0;
  const approvalHandler = handlers.get('approval/request')[0];
  const outcome = approvalHandler({
    toolName: 'pwsh',
    subject: 'command',
    effectiveMode: 'workspace-write',
    requestedMode: 'danger-full-access',
    justification: '需要访问工作区外的路径',
    agent: { session: { header: { cwd: 'D:\\杂类' } } },
  }, async () => { nextCalled += 1; return 'allowed-once'; });
  assert.equal(await outcome, 'allowed-once');
  assert.equal(nextCalled, 1, '必须继续瀑布（否则批准流程被卡住）');
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'DSH 需要你的授权');
  assert.equal(sent[0].launch, 'dsh://open');
  assert.equal(sent[0].sticky, false, '默认带显示时限，不该是常驻的提醒样式');
  assert.equal(sent[0].expiresInSeconds, 10, '默认 10 秒显示时间限制');
  assert.equal(sent[0].aumid, 'com.deepseek.dsh');
  assert.ok(sent[0].lines.some((line) => line.includes('danger-full-access')));
  ok('权限请求：放行瀑布 + 弹出可点击通知');

  const questionHandler = handlers.get('user-questions/request')[0];
  await questionHandler({ questions: [{ id: 'q1', question: '要发布吗？', options: [{ label: '发布' }, { label: '先等等' }] }] }, async () => ({ answers: [] }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, 'DSH 有问题要问你');
  assert.equal(sent[1].body, '要发布吗？');
  ok('AI 提问：弹出带选项的通知');

  handlers.get('agent/turn-stopping')[0]({ agent: { session: { header: { cwd: 'D:\\杂类' } } } });
  assert.equal(sent.length, 2, 'notifyTurnEnd=false 时一轮结束不发通知');
  ok('一轮结束：默认关闭时不发通知');

  handlers.get('agent/error')[0]({ error: new Error('boom'), agent: {} });
  await settle();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].title, 'DSH 出错了');
  assert.match(sent[2].body, /boom/);
  ok('会话出错：弹出错误通知');

  // 点击回到 DSH：启动即解析目标，通知带上 protocol 激活
  await settle();
  assert.ok(targets.length >= 1, '启动时解析点击目标');
  assert.equal(targets[0].scheme, 'dsh-notify');
  ok('启动即解析「点击回到 DSH」的目标');

  // ---------------------------------------------------------------- 模型工具
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'notify_user');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['title', 'message']);
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(
    Object.keys(tool.output.schema.properties).sort(),
    ['body', 'delivered', 'error', 'ok', 'skipped', 'title'],
    '输出 schema 必须覆盖 api.send 可能返回的全部字段（多一个键注册表就拒绝）',
  );
  ok('notify_user 工具：参数 schema 与渲染器齐备');

  const toolResult = await tool.execute({ title: 'AI 标题', message: 'AI 正文' });
  assert.deepEqual(plain(toolResult), { ok: true, delivered: true, title: 'AI 标题', body: 'AI 正文' });
  assert.deepEqual(Object.keys(toolResult).sort(), ['body', 'delivered', 'ok', 'title'], '结果里不能有 undefined 字段（工具结果要求 lossless JSON）');
  assert.equal(JSON.stringify(toolResult).includes('undefined'), false);
  assertAllKeysDeclared('notify_user 成功结果', tool, toolResult);
  assert.equal(sent.length, 4);
  assert.equal(sent[3].title, 'AI 标题');
  const rendered = tool.output.render({}, toolResult);
  assert.match(rendered[0].text, /已发送 Windows 通知/);
  ok('notify_user.execute / render');

  // ---------------------------------------------------------------- 服务与 HTTP
  assert.ok(services.has('windowsNotify'), '发布 ctx.windowsNotify 服务');
  const viaService = await services.get('windowsNotify').send({ title: '服务调用', message: 'hello' });
  assert.equal(viaService.delivered, true);
  ok('ctx.windowsNotify.send 可用');

  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/plugins/dsh-windows-notify/config',
    '/plugins/dsh-windows-notify/decision',
    '/plugins/dsh-windows-notify/decisions',
    '/plugins/dsh-windows-notify/focus',
    '/plugins/dsh-windows-notify/hello',
    '/plugins/dsh-windows-notify/recent',
    '/plugins/dsh-windows-notify/send',
    '/plugins/dsh-windows-notify/status',
  ]);
  const sendRoute = routes.find((route) => route.path.endsWith('/send'));
  const good = makeExchange('POST', { title: '外部脚本', message: '来自 curl' });
  await sendRoute.handler(good.req, good.res);
  assert.equal(good.captured.status, 200);
  assert.equal(JSON.parse(good.captured.body).delivered, true);
  assert.equal(sent[sent.length - 1].title, '外部脚本');
  const bad = makeExchange('POST', { message: '缺少标题' });
  await sendRoute.handler(bad.req, bad.res);
  assert.equal(bad.captured.status, 400);
  const wrongMethod = makeExchange('GET');
  await sendRoute.handler(wrongMethod.req, wrongMethod.res);
  assert.equal(wrongMethod.captured.status, 405);
  ok('HTTP /send：POST 正常、缺 title 400、GET 405');

  const statusRoute = routes.find((route) => route.path.endsWith('/status'));
  const status = makeExchange('GET');
  await statusRoute.handler(status.req, status.res);
  const statusPayload = JSON.parse(status.captured.body);
  assert.equal(status.captured.status, 200);
  assert.equal(statusPayload.available, true);
  assert.equal(statusPayload.click.uri, 'dsh://open');
  assert.equal(typeof statusPayload.sent, 'number');
  ok('HTTP /status：返回可用性、点击目标与已发条数');

  // 通知历史：侧栏「通知」页读它。
  const recentRoute = routes.find((route) => route.path.endsWith('/recent'));
  const recent = makeExchange('GET');
  await recentRoute.handler(recent.req, recent.res);
  const recentPayload = JSON.parse(recent.captured.body);
  assert.equal(recent.captured.status, 200);
  assert.ok(recentPayload.items.length >= 4, `应记录刚才发的通知，实际 ${recentPayload.items.length}`);
  assert.equal(recentPayload.items[0].title, '外部脚本', '新的在前');
  assert.equal(typeof recentPayload.items[0].ts, 'number');
  assert.equal(recentPayload.items[0].ok, true);
  const limited = makeExchange('GET');
  limited.req.url = '/plugins/dsh-windows-notify/recent?limit=2';
  await recentRoute.handler(limited.req, limited.res);
  assert.equal(JSON.parse(limited.captured.body).items.length, 2);
  assert.deepEqual(services.get('windowsNotify').recent(1).length, 1);
  ok('HTTP /recent：通知历史（含 limit 与新的在前）');

  const putRecent = makeExchange('PUT');
  await recentRoute.handler(putRecent.req, putRecent.res);
  assert.equal(putRecent.captured.status, 405);
  ok('HTTP /recent：只接受 GET');

  assert.ok(warnings.length === 0, `不应有警告: ${warnings.join(' | ')}`);
}

// ------------------------------------------------------------ 设置页配置桥
{
  const made = makeCtx();
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async () => ({ ok: true }),
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const route = made.routes.find((item) => item.path.endsWith('/config'));
  assert.ok(route !== undefined, '注册了 /config 路由');

  const read = makeExchange('GET');
  await route.handler(read.req, read.res);
  const readBody = JSON.parse(read.captured.body);
  assert.equal(read.captured.status, 200);
  assert.equal(readBody.ns, 'windows-notify');
  assert.equal(readBody.revision, 7);
  assert.equal(readBody.value.notifyTurnEnd, false);
  ok('配置桥：GET 只取本 entry 的命名空间');

  const write = makeExchange('POST', { ops: [{ op: 'set', path: ['notifyTurnEnd'], value: true }], expectedRevision: 7 });
  await route.handler(write.req, write.res);
  const writeBody = JSON.parse(write.captured.body);
  assert.equal(write.captured.status, 200);
  assert.equal(writeBody.value.notifyTurnEnd, true);
  assert.equal(writeBody.revision, 8);
  assert.deepEqual(made.settingsState.calls[0], {
    ns: 'windows-notify',
    ops: [{ op: 'set', path: ['notifyTurnEnd'], value: true }],
    expectedRevision: 7,
  });
  ok('配置桥：POST 走 settings.mutate 并回读新值');

  const empty = makeExchange('POST', {});
  await route.handler(empty.req, empty.res);
  assert.equal(empty.captured.status, 400);
  ok('配置桥：空 ops → 400');

  const remote = makeExchange('POST', { ops: [{ op: 'set', path: ['enabled'], value: false }] }, { remoteAddress: '10.0.0.7' });
  await route.handler(remote.req, remote.res);
  assert.equal(remote.captured.status, 403);
  ok('配置桥：非回环请求拒绝写入');

  const wrongMethod = makeExchange('PUT');
  await route.handler(wrongMethod.req, wrongMethod.res);
  assert.equal(wrongMethod.captured.status, 405);
  ok('配置桥：PUT → 405');
}

// ------------------------------------------------- 命名空间缺失时的配置桥行为
{
  const made = makeCtx();
  made.ctx.settings.describe = () => [];
  apply(made.ctx, volatileConfig({}), {
    showWindowsToast: async () => ({ ok: true }),
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const route = made.routes.find((item) => item.path.endsWith('/config'));
  const read = makeExchange('GET');
  await route.handler(read.req, read.res);
  assert.equal(read.captured.status, 404);
  ok('配置桥：settings 里没有该命名空间 → 404');
}

// ------------------------------------------------- 显示时间限制
{
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0, displaySeconds: 0, sticky: true }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  made.handlers.get('approval/request')[0]({ toolName: 'pwsh' }, async () => 'allowed-once');
  await settle();
  assert.equal(sent[0].expiresInSeconds, undefined, 'displaySeconds=0 → 不设时限');
  assert.equal(sent[0].sticky, true, '不限时 + sticky 才用常驻的提醒样式');
  ok('显示时间限制：0 = 不限制，此时才允许常驻');

  const made30 = makeCtx();
  const sent30 = [];
  apply(made30.ctx, volatileConfig({ dedupeMs: 0, displaySeconds: 30 }), {
    showWindowsToast: async (options) => { sent30.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const api30 = made30.services.get('windowsNotify');
  await api30.send({ title: 'AI 请求常驻', message: 'x', sticky: true });
  assert.equal(sent30[0].expiresInSeconds, 30, '自定义时限生效');
  assert.equal(sent30[0].sticky, false, '有时限时连 AI 明确要的常驻也被压掉');
  const status30 = await api30.status();
  assert.equal(status30.displaySeconds, 30);
  assert.equal(status30.sticky, false);
  ok('显示时间限制：落在每条通知上，AI 的常驻也受全局时限约束');
}

// ------------------------------------------------- 开关：enabled / 去重 / 限流
{
  const sent = [];
  const made = makeCtx();
  apply(made.ctx, volatileConfig({ enabled: false, dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'desktop', command: '"x"', label: 'x' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  made.handlers.get('approval/request')[0]({ toolName: 'pwsh' }, async () => 'rejected');
  assert.equal(sent.length, 0, 'enabled=false 时状态通知不发');
  ok('enabled=false：状态通知静默');

  // 显式 API 调用不受 enabled 影响
  const sent2 = [];
  const made2 = makeCtx();
  apply(made2.ctx, volatileConfig({ enabled: false, dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent2.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const explicit = await made2.services.get('windowsNotify').send({ title: '显式通知' });
  assert.equal(explicit.delivered, true);
  assert.equal(sent2.length, 1);
  ok('enabled=false：AI/脚本的显式通知仍然发送');
}

// ------------------------------------------------------- 通道故障不得影响会话
{
  const made = makeCtx();
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async () => { throw new Error('powershell 失败'); },
    resolveClickTarget: async () => { throw new Error('注册失败'); },
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const approval = made.handlers.get('approval/request')[0];
  const outcome = await approval({ toolName: 'pwsh' }, async () => 'allowed-once');
  assert.equal(outcome, 'allowed-once', '通知发送失败不能影响批准结果');
  await settle();
  const failed = await made.services.get('windowsNotify').send({ title: 'x' });
  assert.equal(failed.delivered, false);
  assert.equal(failed.error, 'powershell 失败');
  const status = await made.services.get('windowsNotify').status();
  assert.equal(status.click.status, 'failed');
  assert.equal(status.click.reason, '注册失败');
  ok('通知/目标解析失败：只降级并记日志，不影响批准与会话');
}

// ------------------------------------------- 权限通知里的「允许 / 拒绝」按钮
{
  const made = makeCtx();
  const sent = [];
  const removed = [];
  const protoCalls = [];
  // 真实宿主进程里**没有** DSH_WEB_URL（那是注入给 shell 子进程的），这里也去掉，
  // 才能验证「地址只能从请求上学到」这条路径。
  const savedWebUrl = process.env.DSH_WEB_URL;
  delete process.env.DSH_WEB_URL;
  apply(made.ctx, volatileConfig({ dedupeMs: 0, decisionSeconds: 120 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async (options) => { protoCalls.push(options); return { ok: true, changed: true, script: 'test' }; },
    removeWindowsToast: async (target) => { removed.push(target); return { ok: true }; },
  });
  await settle();

  // 还没收到任何请求时，宿主并不知道自己在哪个端口上 → 宁可先不给按钮。
  assert.equal(protoCalls.length, 0, '不知道自身地址时不该注册回传通道');
  const earlyStatus = await made.services.get('windowsNotify').status();
  assert.equal(earlyStatus.decision.status, 'failed');
  assert.equal(earlyStatus.decision.reason, 'no-web-url');
  ok('尚未得知自身地址：按钮通道不注册（宁可不给按钮，也不产生死按钮）');

  // 页面加载时客户端半边会 ping 一次 → 宿主从 socket.localPort 学到自己的地址。
  const hello = await learnOrigin(made);
  assert.equal(protoCalls.length, 1, '学到地址后立即注册回传通道');
  assert.equal(protoCalls[0].base, 'http://127.0.0.1:19387', '地址取自 socket.localPort');
  assert.equal(JSON.parse(hello.captured.body).decision, 'ready');
  ok('第一个请求把宿主自己的地址带过来（socket.localPort）→ 注册按钮回传通道');

  const approval = made.handlers.get('approval/request')[0];
  // 真流程里 next() 会挂住等 GUI 回答；这里用一个永不 settle 的 promise 模拟，
  // 否则 composed 立刻结算会把按钮 token 撤掉。
  const outcomePromise = approval({ toolName: 'pwsh', callId: 'call-1', agent: { id: 'session-abc' }, requestedMode: 'workspace-write' }, () => new Promise(() => {}));
  await settle();
  assert.equal(sent.length, 1);
  const toast = sent[0];
  assert.equal(toast.expiresInSeconds, 120, '按钮可点窗口 = decisionSeconds');
  assert.equal(toast.actions.length, 2);
  assert.equal(toast.actions[0].content, '允许');
  assert.equal(toast.actions[0].style, 'Success');
  assert.match(toast.actions[0].arguments, /^dsh-notify:allow\/[0-9a-f]{16}$/);
  assert.equal(toast.actions[1].content, '拒绝');
  assert.equal(toast.actions[1].style, 'Critical');
  assert.match(toast.actions[1].arguments, /^dsh-notify:reject\/[0-9a-f]{16}$/);
  assert.match(toast.tag, /^ap-[0-9a-f]{8}$/, '每次审批一个独立 tag（否则两个待答审批会互相覆盖）');
  ok('权限通知带上「允许 / 拒绝」按钮（配色 + 一次性 token + 独立 tag）');

  const route = made.routes.find((item) => item.path.endsWith('/decision'));
  const token = /allow\/([0-9a-f]{16})/.exec(toast.actions[0].arguments)[1];

  // 非回环 / 错误 choice / 错误方法都拒绝
  const remote = makeExchange('POST', undefined, { remoteAddress: '10.0.0.7' });
  remote.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=allow`;
  await route.handler(remote.req, remote.res);
  assert.equal(remote.captured.status, 403);
  const wrongChoice = makeExchange('POST');
  wrongChoice.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=maybe`;
  await route.handler(wrongChoice.req, wrongChoice.res);
  assert.equal(wrongChoice.captured.status, 400);
  const wrongMethod = makeExchange('GET');
  wrongMethod.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=allow`;
  await route.handler(wrongMethod.req, wrongMethod.res);
  assert.equal(wrongMethod.captured.status, 405);
  ok('回传口：非回环 403、choice 不合法 400、GET 405');

  // 点「允许」→ 这次审批以 allowed-once 结算
  const allow = makeExchange('POST');
  allow.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=allow`;
  await route.handler(allow.req, allow.res);
  assert.equal(allow.captured.status, 200);
  assert.equal(JSON.parse(allow.captured.body).outcome, 'allowed-once');
  assert.equal(await outcomePromise, 'allowed-once', '批准结果来自通知按钮');
  await settle();
  assert.equal(removed.length, 1, '结算后把那条通知撤掉');
  assert.equal(removed[0].tag, toast.tag);
  assert.ok(made.services.get('windowsNotify').recent(5).some((item) => item.source === 'decision'), '历史里留下「已从通知里允许」');

  // token 一次性
  const again = makeExchange('POST');
  again.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=reject`;
  await route.handler(again.req, again.res);
  assert.equal(again.captured.status, 404);
  ok('点「允许」→ 审批结算 + 通知撤下 + token 一次性');

  // 客户端半边靠这条增量事实去关掉 GUI 里那张还挂着的审批卡。
  const feedRoute = made.routes.find((item) => item.path.endsWith('/decisions'));
  const feed = makeExchange('GET');
  await feedRoute.handler(feed.req, feed.res);
  const feedBody = JSON.parse(feed.captured.body);
  assert.equal(feed.captured.status, 200);
  assert.equal(feedBody.seq, 1);
  assert.deepEqual(feedBody.items, [{
    seq: 1,
    ts: feedBody.items[0].ts,
    outcome: 'allowed-once',
    sessionId: 'session-abc',
    callId: 'call-1',
    toolName: 'pwsh',
  }]);
  assert.equal(typeof feedBody.items[0].ts, 'number');
  const emptyFeed = makeExchange('GET');
  emptyFeed.req.url = '/plugins/dsh-windows-notify/decisions?since=1';
  await feedRoute.handler(emptyFeed.req, emptyFeed.res);
  assert.deepEqual(JSON.parse(emptyFeed.captured.body).items, [], 'since 之后没有新事实');
  assert.equal(JSON.parse(emptyFeed.captured.body).seq, 1);
  ok('HTTP /decisions：把「从通知结算」的事实按 seq 增量给客户端（含 session/callId/toolName）');

  const status = await made.services.get('windowsNotify').status();
  assert.equal(status.decision.status, 'ready');
  assert.equal(status.decision.seconds, 120);
  ok('status 暴露按钮通道与可点窗口');

  if (savedWebUrl === undefined) delete process.env.DSH_WEB_URL;
  else process.env.DSH_WEB_URL = savedWebUrl;
}

// ------------------------------------------- 拒绝 / GUI 先答 / 过期 / 关掉按钮
{
  // 点「拒绝」→ rejected
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
    removeWindowsToast: async () => ({ ok: true }),
  });
  // 先让宿主知道自己的地址（真实部署里由页面加载时的 /hello ping 完成）。
  await learnOrigin(made);
  const approval = made.handlers.get('approval/request')[0];
  const outcomePromise = approval({ toolName: 'pwsh' }, () => new Promise(() => {}));
  await settle();
  const token = /allow\/([0-9a-f]{16})/.exec(sent[0].actions[0].arguments)[1];
  const route = made.routes.find((item) => item.path.endsWith('/decision'));
  const deny = makeExchange('POST');
  deny.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=reject`;
  await route.handler(deny.req, deny.res);
  assert.equal(JSON.parse(deny.captured.body).outcome, 'rejected');
  assert.equal(await outcomePromise, 'rejected');
  ok('点「拒绝」→ 审批以 rejected 结算');
}
{
  // GUI 先回答：按钮 token 立刻作废
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
    removeWindowsToast: async () => ({ ok: true }),
  });
  await learnOrigin(made);
  const approval = made.handlers.get('approval/request')[0];
  const outcome = await approval({ toolName: 'pwsh' }, async () => 'allowed-once');
  assert.equal(outcome, 'allowed-once', 'GUI 先答时用 GUI 的结果');
  await settle();
  const token = /allow\/([0-9a-f]{16})/.exec(sent[0].actions[0].arguments)[1];
  const route = made.routes.find((item) => item.path.endsWith('/decision'));
  const late = makeExchange('POST');
  late.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=reject`;
  await route.handler(late.req, late.res);
  assert.equal(late.captured.status, 404, 'GUI 答完之后按钮失效');
  // GUI 自己答的：卡片本来就会消失，不该往 /decisions 里塞事实（免得客户端去点新卡片）。
  const feed = makeExchange('GET');
  await made.routes.find((item) => item.path.endsWith('/decisions')).handler(feed.req, feed.res);
  assert.deepEqual(JSON.parse(feed.captured.body).items, [], 'GUI 回答不产生「从通知结算」的事实');
  ok('GUI 先回答：按钮 token 立即作废，审批仍用 GUI 的结果');
}
{
  // 按钮窗口过期
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0, decisionSeconds: 1 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
    removeWindowsToast: async () => ({ ok: true }),
  });
  await learnOrigin(made);
  const approval = made.handlers.get('approval/request')[0];
  void approval({ toolName: 'pwsh' }, () => new Promise(() => {}));
  await settle();
  const token = /allow\/([0-9a-f]{16})/.exec(sent[0].actions[0].arguments)[1];
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const route = made.routes.find((item) => item.path.endsWith('/decision'));
  const late = makeExchange('POST');
  late.req.url = `/plugins/dsh-windows-notify/decision?token=${token}&choice=allow`;
  await route.handler(late.req, late.res);
  assert.equal(late.captured.status, 404, '过了 decisionSeconds 按钮就失效');
  ok('按钮可点窗口到期：token 失效，回到 GUI 流程');
}
{
  // 关掉按钮（或通道注册失败）：退回原来的通知，审批仍走 next()
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0, decisionButtons: false }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: false, reason: 'should-not-be-called' }),
  });
  await settle();
  const approval = made.handlers.get('approval/request')[0];
  const outcome = await approval({ toolName: 'pwsh' }, async () => 'rejected');
  await settle();
  assert.equal(outcome, 'rejected');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].actions, undefined, '关掉按钮时通知里没有 actions');
  assert.equal(sent[0].tag, 'dsh-approval');
  ok('decisionButtons=false：退回普通通知，审批仍按原流程走');
}
{
  // 通道注册失败：不发按钮（否则点了会弹「选择打开方式」）
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: false, reason: 'no-web-url' }),
  });
  await settle();
  const approval = made.handlers.get('approval/request')[0];
  const outcome = await approval({ toolName: 'pwsh' }, async () => 'cancelled');
  await settle();
  assert.equal(outcome, 'cancelled');
  assert.equal(sent[0].actions, undefined, '通道没建好就不给按钮');
  ok('按钮通道不可用：退化成普通通知，不产生死按钮');
}

// ------------------------------- A：高危审批不给按钮，只提示去界面确认
{
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
    removeWindowsToast: async () => ({ ok: true }),
  });
  await learnOrigin(made); // 通道 ready，排除「通道不可用」这个干扰项
  const approval = made.handlers.get('approval/request')[0];

  const risky = await approval(
    { toolName: 'pwsh', requestedMode: 'danger-full-access', justification: '需要写工作区外的路径' },
    async () => 'rejected',
  );
  await settle();
  assert.equal(risky, 'rejected', '高危审批照走 GUI 那条路');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].actions, undefined, '通道可用也不给按钮：误点一下就是不受限的特权操作');
  assert.match(sent[0].body, /界面确认/, '正文要告诉用户去界面确认');

  void approval({ toolName: 'pwsh', requestedMode: 'workspace-write' }, () => new Promise(() => {}));
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].actions.length, 2, '同一条通道下，低危审批仍然有按钮');
  ok('A：danger-full-access 不发按钮（提示去界面），低危审批照旧带按钮');
}
{
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0, decisionButtonsFor: 'all' }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
    removeWindowsToast: async () => ({ ok: true }),
  });
  await learnOrigin(made);
  const approval = made.handlers.get('approval/request')[0];
  void approval({ toolName: 'pwsh', requestedMode: 'danger-full-access' }, () => new Promise(() => {}));
  await settle();
  assert.equal(sent[0].actions.length, 2, 'decisionButtonsFor=all 时高危审批也给按钮');
  ok('A：decisionButtonsFor=all 可恢复「高危也给按钮」');
}
{
  assert.equal(isPrivilegedApproval({ requestedMode: 'danger-full-access' }), true);
  assert.equal(isPrivilegedApproval({ justification: 'escalate sandbox to danger-full-access: 测试' }), true);
  assert.equal(isPrivilegedApproval({ requestedMode: 'workspace-write' }), false);
  assert.equal(isPrivilegedApproval({ requestedMode: 'read-only' }), false);
  assert.equal(isPrivilegedApproval({}), false, '字段缺失不能误判成高危');
  assert.equal(isPrivilegedApproval(undefined), false);
  ok('A：高危判据覆盖「模式字段」与「理由文本」两种来源，缺字段不误判');
}

// --------------------------- 前后台：DSH 在前台时只进操作中心（silent）
{
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0 }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const focusRoute = made.routes.find((item) => item.path.endsWith('/focus'));
  const service = made.services.get('windowsNotify');

  // 没人上报过 → 当作后台（fail-open：宁可多弹也不少弹）
  assert.equal((await service.status()).focus.foreground, false);

  const report = async (focused, windowId = 'w1', options = {}) => {
    const exchange = makeExchange('POST', { windowId, focused }, options);
    await focusRoute.handler(exchange.req, exchange.res);
    return JSON.parse(exchange.captured.body);
  };

  assert.equal((await report(true)).foreground, true, '窗口上报前台');
  const statusFocused = await service.status();
  assert.equal(statusFocused.focus.foreground, true);
  assert.equal(statusFocused.focus.policy, 'silent', '默认策略是 silent');

  // 前台 + 自动事件 → 发出去，但带 suppressPopup（不弹横幅，只进操作中心）
  await service.send({ title: 'AI 显式', message: 'x' }); // 显式通知：前台也照常弹
  assert.notEqual(sent.at(-1).suppressPopup, true, 'notify_user / HTTP 这类显式通知不受限制');

  const approval = made.handlers.get('approval/request')[0];
  await approval({ toolName: 'pwsh', requestedMode: 'workspace-write' }, async () => 'rejected');
  await settle();
  const autoToast = sent.filter((item) => item.suppressPopup === true).at(-1);
  assert.ok(autoToast !== undefined, '前台时自动通知要带 suppressPopup');
  assert.equal(autoToast.suppressPopup, true);
  ok('前台（silent）：自动通知只进操作中心（suppressPopup），显式通知照常弹横幅');

  // 转后台 → 恢复弹横幅；再上前台 → 又静默
  await report(false);
  assert.equal((await service.status()).focus.foreground, false);
  await approval({ toolName: 'pwsh', requestedMode: 'workspace-write' }, async () => 'rejected');
  await settle();
  assert.notEqual(sent.at(-1).suppressPopup, true, '后台时正常弹横幅');
  ok('切到后台：通知恢复弹横幅');

  // 非回环的上报要被拒（不然别的程序能骗过前后台判定）
  const remote = await report(true, 'w2', { remoteAddress: '10.0.0.9' });
  assert.equal(remote.ok, false);
  ok('前后台上报只接受本机回环请求');

  // GET 只读：此刻状态是「后台」（非回环那次上报被拒，没改动状态）
  const read = makeExchange('GET');
  await focusRoute.handler(read.req, read.res);
  assert.equal(JSON.parse(read.captured.body).foreground, false);
  assert.equal(JSON.parse(read.captured.body).ttlMs, 45000);
  ok('HTTP /focus：GET 读状态、POST 上报（回环限定）');
}
{
  // skip 档：前台完全不发，但历史里留一条「被前台拦下」
  const made = makeCtx();
  const sent = [];
  apply(made.ctx, volatileConfig({ dedupeMs: 0, whenFocused: 'skip' }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const focusRoute = made.routes.find((item) => item.path.endsWith('/focus'));
  const exchange = makeExchange('POST', { windowId: 'w1', focused: true });
  await focusRoute.handler(exchange.req, exchange.res);
  const approval = made.handlers.get('approval/request')[0];
  await approval({ toolName: 'pwsh', requestedMode: 'workspace-write' }, async () => 'rejected');
  await settle();
  assert.equal(sent.length, 0, 'skip：前台一条都不发');
  const recent = made.services.get('windowsNotify').recent(5);
  assert.equal(recent[0].skipped, 'foreground', '历史里记下「被前台拦下」');
  ok('skip 档：前台完全不发通知，历史里留痕');

  // 显式通知仍然发
  await made.services.get('windowsNotify').send({ title: '显式', message: 'x' });
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].suppressPopup, true);
  ok('skip 档：AI/脚本的显式通知依旧发出');
}
{
  // TTL：心跳停了就当作后台（纯函数，直接喂时间戳）
  const now = 1_000_000;
  assert.equal(isForegroundReport(new Map([['w1', { focused: true, at: now }]]), now), true);
  assert.equal(isForegroundReport(new Map([['w1', { focused: true, at: now - 44000 }]]), now), true, '45 秒内算新鲜');
  assert.equal(isForegroundReport(new Map([['w1', { focused: true, at: now - 60000 }]]), now), false, '过期即当作后台');
  assert.equal(isForegroundReport(new Map([['w1', { focused: false, at: now }]]), now), false);
  assert.equal(isForegroundReport(new Map([['w1', { focused: true, at: now }], ['w2', { focused: false, at: now }]]), now), true, '多窗口取「有一个在前台」');
  assert.equal(isForegroundReport(new Map(), now), false);
  assert.equal(isForegroundReport(undefined, now), false);
  ok('前后台 TTL：心跳超过 45 秒就当后台（fail-open）');
}

// ------------------------------------------------------------ 去重 / 限流 / 焦点
{
  const sent = [];
  const made = makeCtx();
  apply(made.ctx, volatileConfig({ dedupeMs: 60000, maxPerMinute: 2, focusOnClick: false, decisionButtons: false }), {
    showWindowsToast: async (options) => { sent.push(options); return { ok: true }; },
    resolveClickTarget: async () => APP_TARGET,
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: true, reason: 'ok' }),
    ensureDecisionProtocol: async () => ({ ok: true, changed: false, script: 'test' }),
  });
  const approval = made.handlers.get('approval/request')[0];
  await approval({ toolName: 'pwsh' }, async () => 'allowed-once');
  await approval({ toolName: 'pwsh' }, async () => 'allowed-once');
  assert.equal(sent.length, 1, '关掉按钮时走老路径：同一 tag 在 dedupeMs 内只弹一次');
  const api = made.services.get('windowsNotify');
  await api.send({ title: 't1', message: 'm', tag: 'a' });
  await api.send({ title: 't2', message: 'm', tag: 'b' });
  const third = await api.send({ title: 't3', message: 'm', tag: 'c' });
  assert.equal(third.skipped, 'rate-limited', '超过每分钟上限被限流');
  assert.equal(sent.every((options) => options.launch === undefined), true, 'focusOnClick=false 时不带协议激活');
  ok('去重 / 每分钟限流 / 关闭点击回 DSH');
}

// -------------------------------------------------------------- 非 Windows 平台
{
  const made = makeCtx();
  apply(made.ctx, volatileConfig({}), {
    showWindowsToast: async () => { throw new Error('不应被调用'); },
    resolveClickTarget: async () => ({ ok: false, mode: 'none', reason: 'not-windows' }),
    detectLauncher: () => ({ kind: 'none', label: '' }),
    toastAvailability: () => ({ available: false, reason: 'not-windows' }),
  });
  const result = await made.services.get('windowsNotify').send({ title: 'x' });
  assert.equal(result.delivered, false);
  assert.equal(result.skipped, 'not-windows');
  ok('非 Windows：安静跳过而不是报错');
}

console.log(`\n${passed} checks passed.`);
