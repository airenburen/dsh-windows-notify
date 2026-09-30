/**
 * dsh-windows-notify 的浏览器半边。两个职责：
 *
 * 1. **配置页**：优先注册进 DSH-better-sidebar 的设置页——它给每个注册的 tab 类型
 *    在「设置 → 侧边栏卡片」里放一张卡片，`settings.render` 就是卡片齿轮里那个面板。
 *    本插件注册一个 `hidden: true` 的 tab 类型：不进 DSH 原生「+」菜单（不会多出
 *    一个用不上的侧栏页），但设置卡片照常出现（编辑器 / diff 内置类型就是这个套路）。
 *    没装 better-sidebar 时退回到插件自己的行配置页（`plugins.row.config`，key =
 *    `<包名>#<patch 里的 row id>`）。
 * 2. **tab 本体**：万一被打开，它显示通知通道状态、最近发出的通知，并提供测试按钮。
 *
 * 配置读写只走宿主半边的桥：
 *   GET  /plugins/dsh-windows-notify/config  → { value, revision }
 *   POST /plugins/dsh-windows-notify/config  → { ops, expectedRevision }
 * （写穿 DSH 的 settings 服务，落盘位置与「设置」层一致。）
 *
 * 本文件是**已构建 bundle** 的格式（dsh-client-modules 要求 lib/client.js 已就绪）：
 * window.__ModuleLoader__.load({ id, factory }) + CJS 工厂，平台模块用 require 取。
 * 不需要任何构建步骤；只用 React，不依赖任何私有 UI 组件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-windows-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const BASE = '/plugins/dsh-windows-notify';
    const TAB_ID = 'dsh-windows-notify';
    const ROW_KEY = 'dsh-windows-notify#windows-notify';

    /** 最近一次读到的配置，供 summary 视图使用。 */
    let lastValue = undefined;

    /** 界面语言：跟着浏览器走（够用；better-sidebar 有自己的 locale 服务）。 */
    function isZh() {
      const raw = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'zh';
      return String(raw).toLowerCase().startsWith('zh');
    }
    const t = (zh, en) => (isZh() ? zh : en);

    const FIELDS = [
      { key: 'enabled', type: 'boolean', label: ['启用状态通知', 'Enable state notifications'], hint: ['关掉后只有 AI / 脚本显式调用的通知会弹出', 'AI / script calls still notify'] },
      { key: 'notifyApproval', type: 'boolean', label: ['需要权限时通知', 'Notify on approval'], hint: ['命令、文件操作等需要你确认权限时', 'When a command or file op needs your approval'] },
      { key: 'notifyQuestion', type: 'boolean', label: ['AI 提问时通知', 'Notify on questions'], hint: ['ask_user_question / 计划确认', 'ask_user_question / plan review'] },
      { key: 'notifyTurnEnd', type: 'boolean', label: ['一轮回复结束时通知', 'Notify when a turn ends'] },
      { key: 'notifyError', type: 'boolean', label: ['会话出错时通知', 'Notify on errors'] },
      { key: 'agentTool', type: 'boolean', label: ['注册 notify_user 工具', 'Register the notify_user tool'], hint: ['允许 AI 自己发通知（改完需重载插件生效）', 'Lets the model send notifications (needs a plugin reload)'] },
      { key: 'httpApi', type: 'boolean', label: ['开放 HTTP 接口', 'Expose the HTTP API'], hint: ['POST /plugins/dsh-windows-notify/send', 'POST /plugins/dsh-windows-notify/send'] },
      { key: 'focusOnClick', type: 'boolean', label: ['点击通知回到 DSH', 'Click to return to DSH'], hint: ['桌面端用应用自带的 dsh://open 协议', 'Desktop uses the app’s own dsh://open protocol'] },
      { key: 'sound', type: 'boolean', label: ['提示音', 'Sound'] },
      { key: 'displaySeconds', type: 'number', label: ['显示时间限制（秒）', 'Display limit (seconds)'], hint: ['到点自动从屏幕与操作中心移除；0 = 不限制', 'Auto-removed from screen and Action Center; 0 = no limit'] },
      { key: 'sticky', type: 'boolean', label: ['状态通知常驻（提醒样式）', 'Sticky state toasts'], hint: ['仅在显示时间限制为 0 时生效', 'Only applies while the display limit is 0'] },
      { key: 'decisionButtons', type: 'boolean', label: ['权限通知带「允许 / 拒绝」按钮', 'Allow / Deny buttons on approval toasts'], hint: ['只给「允许 / 拒绝」两选项的权限申请加；点了直接结算这次审批', 'Only for allow/deny approvals; a click settles the request'] },
      { key: 'decisionSeconds', type: 'number', label: ['按钮可点窗口（秒）', 'Button window (seconds)'], hint: ['带按钮的通知停留这么久，之后按钮失效；0 = 跟随显示时间限制', 'How long the buttons stay actionable; 0 = follow the display limit'] },
      { key: 'decisionButtonsFor', type: 'select', label: ['哪些审批带按钮', 'Which approvals get buttons'], options: [['safe-only', '仅非高危审批'], ['all', '全部审批（含危险权限）']], hint: ['高危的 danger-full-access 建议只去界面确认，避免误点放行', 'danger-full-access is safer to confirm in the GUI'] },
      { key: 'whenFocused', type: 'select', label: ['DSH 在前台时', 'When DSH is focused'], options: [['silent', '只进操作中心（不弹横幅）'], ['skip', '完全不发'], ['notify', '照常弹']], hint: ['只作用于自动状态通知；notify_user / HTTP 的显式通知照常弹', 'Applies to automatic state notifications; explicit ones still pop'] },
      { key: 'language', type: 'select', label: ['通知语言', 'Notification language'], options: [['zh', '中文'], ['en', 'English']] },
      { key: 'aumid', type: 'text', label: ['通知来源 AppID (AUMID)', 'Toast source AppID (AUMID)'], hint: ['桌面版默认 com.deepseek.dsh', 'Desktop default: com.deepseek.dsh'] },
      { key: 'dedupeMs', type: 'number', label: ['同 tag 去重窗口（毫秒）', 'Dedupe window (ms)'] },
      { key: 'maxPerMinute', type: 'number', label: ['每分钟通知上限', 'Max notifications per minute'] },
      { key: 'debugLog', type: 'boolean', label: ['调试日志', 'Debug log'] },
    ];

    const COLOR = {
      error: '#ff453a',
      ok: '#30d158',
      muted: 'rgba(128,128,128,.9)',
      border: 'rgba(128,128,128,.35)',
    };

    function controlStyle() {
      return {
        padding: '4px 8px',
        borderRadius: '6px',
        border: `1px solid ${COLOR.border}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        flex: 'none',
        cursor: 'pointer',
      };
    }

    async function jsonFetch(url, options) {
      const response = await fetch(url, options);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    async function readConfig() {
      const body = await jsonFetch(`${BASE}/config`, { headers: { accept: 'application/json' } });
      lastValue = body.value;
      return body;
    }

    async function writeConfig(ops, expectedRevision) {
      const body = await jsonFetch(`${BASE}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ops, expectedRevision }),
      });
      lastValue = body.value;
      return body;
    }

    /** 发一条测试通知，顺便验证通知链路与点击回到 DSH。 */
    async function sendTest() {
      const body = await jsonFetch(`${BASE}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          title: t('DSH 通知测试', 'DSH notification test'),
          message: t('这是设置页发出的测试通知，点击它应该回到 DSH。', 'Sent from the settings panel — clicking it should return to DSH.'),
          tag: 'dsh-settings-test',
          sticky: false,
        }),
      });
      if (body.delivered !== true) throw new Error(body.skipped ?? 'not delivered');
      return body;
    }

    function row(children, extra) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', minWidth: 0, ...extra } }, children);
    }

    function textBlock(label, hint) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, [
        h('div', { key: 'l', style: { fontSize: '14px' } }, label),
        hint === undefined ? null : h('div', { key: 'h', style: { fontSize: '12px', color: COLOR.muted } }, hint),
      ]);
    }

    function Field({ field, value, disabled, onChange }) {
      const label = Array.isArray(field.label) ? t(field.label[0], field.label[1]) : field.label;
      const hint = field.hint === undefined ? undefined : t(field.hint[0], field.hint[1]);
      const control = (() => {
        if (field.type === 'boolean') {
          return h('input', {
            type: 'checkbox',
            checked: value === true,
            disabled,
            style: { width: '16px', height: '16px', flex: 'none', cursor: disabled ? 'default' : 'pointer' },
            onChange: (event) => onChange(event.target.checked),
          });
        }
        if (field.type === 'select') {
          return h('select', {
            value: value === undefined ? '' : String(value),
            disabled,
            style: { ...controlStyle(), minWidth: '120px' },
            onChange: (event) => onChange(event.target.value),
          }, field.options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)));
        }
        if (field.type === 'number') {
          return h('input', {
            type: 'number',
            value: value === undefined || value === null ? '' : String(value),
            disabled,
            style: { ...controlStyle(), width: '110px', textAlign: 'right' },
            onChange: (event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(next);
            },
          });
        }
        return h('input', {
          type: 'text',
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          style: { ...controlStyle(), minWidth: '200px' },
          onChange: (event) => onChange(event.target.value),
        });
      })();
      return row([textBlock(label, hint), control], { padding: '6px 0', borderBottom: `1px solid ${COLOR.border}` });
    }

    function summarize(value = lastValue) {
      if (value === undefined) return t('Windows 系统通知 + 点击回到 DSH', 'Windows toasts + click to return to DSH');
      if (value.enabled !== true) return t('状态通知已关闭（AI / 脚本仍可显式发送）', 'State notifications are off (AI / scripts can still send)');
      const on = [];
      if (value.notifyApproval === true) on.push(t('权限', 'approval'));
      if (value.notifyQuestion === true) on.push(t('提问', 'questions'));
      if (value.notifyError === true) on.push(t('出错', 'errors'));
      if (value.notifyTurnEnd === true) on.push(t('回合结束', 'turn end'));
      const limit = Number(value.displaySeconds) > 0
        ? ` · ${String(Number(value.displaySeconds))}s`
        : t(' · 不限制', ' · no limit');
      return on.length === 0
        ? t(`状态通知已开启（当前没有勾选任何场景）${limit}`, `Enabled, but no scenario is selected${limit}`)
        : `${t('通知场景', 'Scenarios')}: ${on.join(' / ')}${limit}`;
    }

    /** 设置面板：行配置页与 better-sidebar 的设置弹窗共用。 */
    function ConfigPanel({ compact }) {
      const [state, setState] = React.useState({ status: 'loading', value: undefined, revision: undefined, error: undefined, busy: false, note: undefined });

      const load = React.useCallback(() => {
        setState((previous) => ({ ...previous, status: 'loading', error: undefined }));
        readConfig().then(
          (body) => setState({ status: 'ready', value: body.value ?? {}, revision: body.revision, error: undefined, busy: false, note: undefined }),
          (error) => setState((previous) => ({ ...previous, status: 'error', error: String(error && error.message ? error.message : error) })),
        );
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const apply = (key, value) => {
        setState((previous) => ({ ...previous, value: { ...(previous.value ?? {}), [key]: value }, busy: true, note: undefined }));
        writeConfig([{ op: 'set', path: [key], value }], state.revision).then(
          (body) => setState((previous) => ({ ...previous, value: body.value ?? previous.value, revision: body.revision, busy: false, note: t('已保存', 'Saved') })),
          (error) => setState((previous) => ({ ...previous, busy: false, error: String(error && error.message ? error.message : error), note: undefined })),
        );
      };

      const test = () => {
        setState((previous) => ({ ...previous, busy: true, note: t('正在发送…', 'Sending…'), error: undefined }));
        sendTest().then(
          () => setState((previous) => ({ ...previous, busy: false, note: t('测试通知已发出，点它试试回到 DSH', 'Test toast sent — click it to return to DSH') })),
          (error) => setState((previous) => ({ ...previous, busy: false, note: undefined, error: String(error && error.message ? error.message : error) })),
        );
      };

      if (state.status === 'loading') return h('div', { style: { padding: '12px 0', color: COLOR.muted } }, t('正在读取配置…', 'Loading configuration…'));
      if (state.status === 'error') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 0' } }, [
          h('div', { key: 'e', style: { color: COLOR.error } }, `${t('读取配置失败', 'Failed to read configuration')}: ${state.error}`),
          h('button', { key: 'r', type: 'button', style: controlStyle(), onClick: load }, t('重试', 'Retry')),
        ]);
      }

      const value = state.value ?? {};
      const statusText = state.error !== undefined
        ? state.error
        : (state.note ?? (state.busy ? t('保存中…', 'Saving…') : ''));

      const header = row([
        compact
          ? h('div', { key: 't', style: { fontSize: '13px', color: COLOR.muted } }, summarize(value))
          : h('div', { key: 't', style: { fontWeight: 600, fontSize: '15px' } }, t('Windows 通知', 'Windows notifications')),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } }, [
          h('span', { key: 'note', style: { fontSize: '12px', color: state.error === undefined ? COLOR.ok : COLOR.error, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, statusText),
          h('button', { key: 'test', type: 'button', style: controlStyle(), disabled: state.busy, onClick: test }, t('发送测试通知', 'Send test toast')),
        ]),
      ], { paddingBottom: '8px' });

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0,
          // 19 个字段塞进设置弹窗一定会溢出，而外层容器多半是 overflow:hidden
          // （按钮被挤到看不见）。这里自己滚：头部（状态 + 测试按钮）钉住，字段列表可滚。
          maxHeight: 'min(70vh, 640px)',
        },
      }, [
        header,
        h('div', {
          key: 'fields',
          style: {
            display: 'flex', flexDirection: 'column', gap: '4px',
            overflowY: 'auto', overflowX: 'hidden', minHeight: 0, paddingRight: '6px',
            scrollbarWidth: 'thin',
          },
        }, FIELDS.map((field) => h(Field, {
          key: field.key,
          field,
          value: value[field.key],
          disabled: state.busy,
          onChange: (next) => apply(field.key, next),
        }))),
      ]);
    }

    /** tab 本体（`hidden: true` 的注册通常不会把它开出来，但打开时它要有用）。 */
    function NotifyTabBody() {
      const [state, setState] = React.useState({ status: 'loading', info: undefined, items: [], error: undefined, busy: false, note: undefined });

      const load = React.useCallback(() => {
        Promise.all([
          fetch(`${BASE}/status`).then((response) => response.json()),
          fetch(`${BASE}/recent`).then((response) => response.json()),
        ]).then(
          ([status, recent]) => setState({ status: 'ready', info: status, items: Array.isArray(recent.items) ? recent.items : [], error: undefined, busy: false, note: undefined }),
          (error) => setState((previous) => ({ ...previous, status: 'error', error: String(error && error.message ? error.message : error) })),
        );
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const test = () => {
        setState((previous) => ({ ...previous, busy: true, note: t('正在发送…', 'Sending…'), error: undefined }));
        sendTest().then(
          () => { setState((previous) => ({ ...previous, busy: false, note: t('已发出', 'Sent') })); load(); },
          (error) => setState((previous) => ({ ...previous, busy: false, note: undefined, error: String(error && error.message ? error.message : error) })),
        );
      };

      if (state.status === 'loading') return h('div', { style: { padding: '12px' } }, t('读取中…', 'Loading…'));
      if (state.status === 'error') return h('div', { style: { padding: '12px', color: COLOR.error } }, state.error);

      const info = state.info ?? {};
      const line = (label, value) => row([h('span', { key: 'l', style: { color: COLOR.muted } }, label), h('span', { key: 'v' }, value)], { padding: '4px 0' });

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', fontSize: '13px' } }, [
        row([
          h('div', { key: 'title', style: { fontWeight: 600 } }, t('通知通道', 'Notification channel')),
          h('button', { key: 'test', type: 'button', style: controlStyle(), disabled: state.busy, onClick: test }, t('发送测试通知', 'Send test toast')),
        ]),
        state.note === undefined && state.error === undefined ? null : h('div', { key: 'note', style: { color: state.error === undefined ? COLOR.ok : COLOR.error } }, state.error ?? state.note),
        line(t('系统通道', 'Platform'), info.available === true ? t('可用', 'available') : t(`不可用（${info.unavailableReason ?? '未知'}）`, `unavailable (${info.unavailableReason ?? 'unknown'})`)),
        line(t('通知来源', 'Source AppID'), String(info.aumid ?? '-')),
        line(t('点击通知', 'Click action'), info.click && info.click.ok === true ? `${info.click.mode} → ${info.click.uri}` : t('未启用', 'disabled')),
        line(
          t('DSH 前后台', 'DSH focus'),
          info.focus === undefined
            ? t('未知', 'unknown')
            : `${info.focus.foreground === true ? t('前台', 'foreground') : t('后台', 'background')} · ${String(info.focus.windows ?? 0)} ${t('个窗口上报', 'window(s) reporting')} · ${t('策略', 'policy')} ${String(info.focus.policy ?? '-')}`,
        ),
        h('div', { key: 'hint', style: { color: COLOR.muted, lineHeight: 1.6 } }, t('完整设置：设置 → 侧边栏卡片 → 「通知」卡片右侧齿轮。', 'All settings: Settings → Side cards → the “Notifications” card’s gear.')),
        h('div', { key: 'h', style: { fontWeight: 600, paddingTop: '4px' } }, t('最近通知', 'Recent notifications')),
        state.items.length === 0
          ? h('div', { key: 'empty', style: { color: COLOR.muted } }, t('还没有发出过通知', 'Nothing sent yet'))
          : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, state.items.slice(0, 20).map((item, index) => h('div', {
            key: `${String(item.ts)}-${String(index)}`,
            style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 0', borderTop: `1px solid ${COLOR.border}` },
          }, [
            row([h('span', { key: 't', style: { fontWeight: 500 } }, String(item.title ?? '')), h('span', { key: 'ts', style: { color: COLOR.muted, fontSize: '12px' } }, new Date(Number(item.ts) || Date.now()).toLocaleTimeString())]),
            item.body === undefined || item.body === '' ? null : h('div', { key: 'b', style: { color: COLOR.muted } }, String(item.body)),
          ]))),
      ]);
    }

    const inject = ['slots'];

    /** 审批卡上两个按钮的文案（DOM 兜底路线按它找）。 */
    const APPROVAL_BUTTON_LABELS = {
      'allowed-once': ['允许一次', 'Allow once'],
      rejected: ['拒绝', 'Reject'],
    };
    /** 审批卡自身的标题文案，用来确认点的是这张卡、不是别处的同名按钮。 */
    const APPROVAL_CARD_TITLES = ['等待审批', 'Waiting for approval'];
    /** 有待审批时才轮询宿主，避免空闲时白跑。 */
    const DECISION_POLL_MS = 1200;
    /** 前后台心跳间隔：宿主 45 秒没消息就当后台，这里 15 秒一次足够稳。 */
    const FOCUS_HEARTBEAT_MS = 15000;

    /** 往上找若干层，看这个按钮是不是长在审批卡里。 */
    function insideApprovalCard(button) {
      let node = button;
      for (let depth = 0; node !== undefined && node !== null && depth < 6; depth += 1) {
        const text = typeof node.textContent === 'string' ? node.textContent : '';
        if (APPROVAL_CARD_TITLES.some((title) => text.includes(title))) return true;
        node = node.parentElement;
      }
      return false;
    }

    /**
     * B 路线（兜底）：不依赖任何内部 API，按文案在 DOM 里找到审批卡的按钮并点它。
     * @param {string} outcome - `allowed-once` | `rejected`
     * @returns {boolean} 是否点到了
     */
    function clickApprovalButton(outcome) {
      if (typeof document === 'undefined' || document === null) return false;
      const labels = APPROVAL_BUTTON_LABELS[outcome] ?? [];
      let buttons;
      try {
        buttons = Array.from(document.querySelectorAll('button'));
      } catch {
        return false;
      }
      for (const button of buttons) {
        const aria = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') ?? '' : '';
        const text = `${aria} ${typeof button.textContent === 'string' ? button.textContent : ''}`;
        if (!labels.some((label) => text.includes(label))) continue;
        if (button.disabled === true) continue;
        if (!insideApprovalCard(button)) continue;
        try {
          button.click();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    /**
     * A 路线（首选）：直接结算 uiSession 里那个 pending approval 实例。
     *
     * GUI 的卡片是在客户端的 `approval/request` 瀑布里创建的一个 pending interaction，
     * 只有**它自己**结束（answer/delegate/abort）时才会被摘掉——宿主那边的答案它看不到。
     * 实例上的 `answer()` 是公开方法，答完它的 finally 就 remove 了；宿主早已落盘，
     * 这次迟到的回答会被瀑布丢弃（实例自带 already-settled 守卫，抛错就退到 B）。
     *
     * @param {object} interaction - pending interaction
     * @param {string} outcome - `allowed-once` | `rejected`
     * @returns {boolean} 是否成功发起
     */
    function answerPendingLocally(interaction, outcome) {
      if (interaction === undefined || interaction === null) return false;
      if (interaction.kind !== undefined && interaction.kind !== 'approval') return false;
      if (typeof interaction.answer !== 'function') return false;
      if (interaction.answerable === false) return false;
      try {
        void Promise.resolve(interaction.answer(outcome)).catch(() => {
          clickApprovalButton(outcome);
        });
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 盯着「已从通知按钮结算」的事实，把 GUI 里那张还挂着的审批卡收掉。
     * 只有在本地真的存在待审批时才去问宿主，空闲时零请求。
     */
    function installDecisionWatcher(ctx) {
      let since;
      let busy = false;

      const readDecisions = async (sinceSeq) => {
        try {
          const query = sinceSeq === undefined ? '' : `?since=${String(sinceSeq)}`;
          const response = await fetch(`${BASE}/decisions${query}`, { headers: { accept: 'application/json' } });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.ok !== true) return undefined;
          return { seq: Number(body.seq) || 0, items: Array.isArray(body.items) ? body.items : [] };
        } catch {
          return undefined;
        }
      };

      ctx.inject(['uiSession'], (sctx) => {
        /** 本地还挂着的审批交互（uiSession 的 pending 投影，值就是 PendingApproval 实例）。 */
        const pendingApprovals = () => {
          try {
            const snapshot = sctx.uiSession?.sessionStatus?.getSnapshot?.();
            if (snapshot === undefined || snapshot === null) return [];
            const entries = typeof snapshot[Symbol.iterator] === 'function' ? Array.from(snapshot) : Object.entries(snapshot);
            const found = [];
            for (const [sessionId, value] of entries) {
              const interaction = value?.pendingInteraction;
              if (interaction === undefined || interaction === null) continue;
              if (interaction.kind !== 'approval') continue;
              found.push({ sessionId: String(sessionId), interaction });
            }
            return found;
          } catch {
            return [];
          }
        };

        const applyDecision = (item, local) => {
          const outcome = item.outcome === 'rejected' ? 'rejected' : 'allowed-once';
          const wanted = typeof item.sessionId === 'string' ? item.sessionId : '';
          const match = (wanted !== '' ? local.find((entry) => entry.sessionId === wanted) : undefined)
            ?? (local.length === 1 ? local[0] : undefined);
          if (match === undefined) return;
          if (answerPendingLocally(match.interaction, outcome)) return;
          clickApprovalButton(outcome);
        };

        const tick = async () => {
          if (busy) return;
          const local = pendingApprovals();
          if (local.length === 0) {
            // 没有待审批：清掉基线，免得旧事实误伤下一张卡片。
            since = undefined;
            return;
          }
          busy = true;
          try {
            if (since === undefined) {
              const baseline = await readDecisions();
              if (baseline !== undefined) since = baseline.seq;
              return;
            }
            const feed = await readDecisions(since);
            if (feed === undefined) return;
            since = feed.seq;
            for (const item of feed.items) applyDecision(item, local);
          } finally {
            busy = false;
          }
        };

        sctx.effect(() => {
          const timer = setInterval(() => {
            void tick();
          }, DECISION_POLL_MS);
          // 浏览器里 setInterval 返回数字；Node（自检环境）里是对象，别让它吊住进程。
          if (typeof timer?.unref === 'function') timer.unref();
          return () => clearInterval(timer);
        }, 'windows-notify: settle approvals answered from the toast');

        // 自检用：让测试不必等轮询周期（客户端模块契约只要求 apply/inject）。
        module.exports.__decisionTick = tick;
      });
    }

    /**
     * 上报「DSH 窗口是不是在前台」。
     *
     * 宿主是独立 Node 进程（`ELECTRON_RUN_AS_NODE`），拿不到 Electron 的窗口状态；
     * 渲染进程这边一句 `document.hasFocus()` 就够。焦点一变就报，平时靠心跳续期
     * （宿主 45 秒收不到消息就当作后台，宁可多弹一条也不漏）。页面关掉/崩溃自然停跳，
     * TTL 到期后宿主恢复「照常弹」。
     */
    function installFocusReporter() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const windowId = (() => {
        try {
          if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 8);
        } catch {
          /* 忽略 */
        }
        return Math.random().toString(16).slice(2, 10);
      })();

      let last;
      const report = (force) => {
        const focused = document.visibilityState === 'visible' && document.hasFocus() === true;
        if (force !== true && focused === last) return;
        last = focused;
        try {
          void fetch(`${BASE}/focus`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ windowId, focused }),
          }).catch(() => {});
        } catch {
          /* 非浏览器环境：忽略 */
        }
      };

      try {
        // 事件里按「算出来的状态」去重：焦点事件偶尔会重复触发，没必要打两次请求。
        window.addEventListener('focus', () => report(false));
        window.addEventListener('blur', () => report(false));
        window.addEventListener('pagehide', () => report(false));
        document.addEventListener('visibilitychange', () => report(false));
      } catch {
        /* 忽略 */
      }
      report(true);
      // 心跳强制上报（状态没变也发），宿主靠它续 TTL：45 秒收不到就当后台。
      const timer = setInterval(() => report(true), FOCUS_HEARTBEAT_MS);
      if (typeof timer?.unref === 'function') timer.unref();

      // 自检用：直接触发一次上报，不必等事件。
      module.exports.__focusReport = report;
    }

    function apply(ctx) {
      // 让宿主尽早知道自己的监听地址（按钮回传脚本里要写死它）。一次性、失败无所谓。
      // 相对地址在没有 URL 基（非浏览器环境）时会**同步**抛错，所以两条路都要兜。
      try {
        void fetch(`${BASE}/hello`, { method: 'POST', headers: { accept: 'application/json' } }).catch(() => {});
      } catch {
        /* 非浏览器环境：忽略 */
      }

      /** 兜底页（插件行配置页）的注销函数；装了 better-sidebar 就撤掉它。 */
      let disposeRowPage;

      const registerRowPage = () => ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          { name: 'plugins.row.config', key: ROW_KEY },
          (slotProps) => (slotProps && slotProps.view === 'summary' ? summarize() : h(ConfigPanel, { compact: false })),
        ));

      disposeRowPage = registerRowPage();

      // DSH 原生设置页（和 dsh-market 同一套槽位机制）：设置 → 左侧导航多一格「通知」。
      // 用自己的 id —— 复用别人的 id 会把对方那一页顶掉；order 55 排在「插件市场」(40) 后面。
      // 这一格不依赖 better-sidebar，它被卸掉也照样在。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'dsh-windows-notify', order: 55, label: () => t('通知', 'Notifications') },
          () => h(ConfigPanel, { compact: false }),
        ));

      // 前后台上报（宿主靠它决定「前台时只进操作中心」）。
      installFocusReporter();

      // 「从通知按钮结算」的事实 → 收掉 GUI 里那张还挂着的审批卡（A 主力 + B 兜底）。
      installDecisionWatcher(ctx);

      // 有 DSH-better-sidebar 时，设置搬到它的设置页（设置 → 侧边栏卡片 → 通知 → 齿轮）。
      ctx.inject(['betterSidebar'], (sctx) => {
        if (typeof disposeRowPage === 'function') {
          try {
            disposeRowPage();
          } catch (error) {
            console.error('[dsh-windows-notify] failed to drop the fallback settings page', error);
          }
          disposeRowPage = undefined;
        }
        sctx.effect(() => sctx.betterSidebar.registerTab({
          id: TAB_ID,
          title: () => t('通知', 'Notifications'),
          description: () => t('Windows 通知与「点击回到 DSH」的设置', 'Windows toast settings and click-to-return'),
          order: 900,
          // 与编辑器 / diff 内置类型同样的套路：给设置卡片，但不进「+」菜单。
          hidden: true,
          single: true,
          settings: { render: () => h(ConfigPanel, { compact: true }) },
          component: () => h(NotifyTabBody),
        }));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
