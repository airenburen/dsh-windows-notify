/**
 * 通知文案：把 DSH 的宿主事件/工具入参整理成一条 toast 的标题、正文与补充行。
 *
 * 所有字段读取都是防御式的：DSH 内部事件对象不是稳定 API，字段缺失时降级为
 * 一句通用文案，绝不抛异常（事件瀑布里抛错会打断批准/提问流程）。
 *
 * @module dsh-windows-notify/messages
 */

/** 沙箱权限里最高的一档：拿到它就不再受工作区限制。 */
const PRIVILEGED_MODE = 'danger-full-access';

const ZH = {
  approvalTitle: 'DSH 需要你的授权',
  approvalBody: (tool, subject) => `${tool} 想执行${subject}，需要你确认权限`,
  approvalSubjectCommand: '一条命令',
  approvalSubjectFile: '一次文件操作',
  approvalSubjectGeneric: '一个操作',
  approvalNoReason: '（模型没有给出理由）',
  questionTitle: 'DSH 有问题要问你',
  questionBody: '模型在等你回答后才能继续',
  questionOptions: (list) => `可选：${list}`,
  questionMore: (count) => `还有 ${count} 个问题`,
  turnEndTitle: 'DSH 回复完成',
  turnEndBody: '本轮已经结束，可以回来看了',
  errorTitle: 'DSH 出错了',
  errorBody: '本轮执行失败，需要你看一下',
  agentToolTitle: 'DSH 通知',
  toolLabel: '工具',
  modeLabel: '权限',
  reasonLabel: '理由',
  sessionLabel: '会话',
  replyLabel: '回复',
  allowAction: '允许',
  rejectAction: '拒绝',
  allowedFromToast: '已从通知里「允许」',
  rejectedFromToast: '已从通知里「拒绝」',
  guiOnly: '高危权限，请到 DSH 界面确认',
};

const EN = {
  approvalTitle: 'DSH needs your approval',
  approvalBody: (tool, subject) => `${tool} wants to run ${subject} and needs your approval`,
  approvalSubjectCommand: 'a command',
  approvalSubjectFile: 'a file operation',
  approvalSubjectGeneric: 'an operation',
  approvalNoReason: '(no justification given)',
  questionTitle: 'DSH has a question',
  questionBody: 'The model is waiting for your answer',
  questionOptions: (list) => `Options: ${list}`,
  questionMore: (count) => `+${count} more question(s)`,
  turnEndTitle: 'DSH finished replying',
  turnEndBody: 'This turn is done',
  errorTitle: 'DSH hit an error',
  errorBody: 'The turn failed and needs your attention',
  agentToolTitle: 'DSH notification',
  toolLabel: 'Tool',
  modeLabel: 'Permission',
  reasonLabel: 'Reason',
  sessionLabel: 'Session',
  replyLabel: 'Reply',
  allowAction: 'Allow',
  rejectAction: 'Deny',
  allowedFromToast: 'Allowed from the toast',
  rejectedFromToast: 'Denied from the toast',
  guiOnly: 'privileged request — confirm in DSH',
};

/** 按配置取词典。 */
export function dictionary(lang) {
  return lang === 'en' ? EN : ZH;
}

/** 单行折叠 + 截断，避免通知里出现换行/超长文本。 */
export function oneLine(text, max = 220) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 会话标签（标题优先，其次目录名）。 */
export function sessionLabel(agent) {
  const session = agent?.session;
  const title = session?.header?.title ?? session?.title ?? session?.header?.summary;
  if (typeof title === 'string' && title.trim() !== '') return oneLine(title, 60);
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return oneLine(parts[parts.length - 1] ?? cwd, 40) || undefined;
  }
  return undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 判断批准请求的「对象」是命令还是文件操作。 */
function approvalSubject(request, dict) {
  const subject = firstString(request?.subject, request?.subjectKind);
  if (subject === 'command') return dict.approvalSubjectCommand;
  if (subject === 'file' || subject === 'path' || subject === 'write') return dict.approvalSubjectFile;
  return dict.approvalSubjectGeneric;
}

/**
 * 这条审批是不是「高危」：申请/生效模式就是 `danger-full-access`，或理由里明确提到它。
 * 高危审批默认**不发通知按钮**（误点一下就等于放行不受工作区限制的操作），
 * 只弹一条提示去界面确认的通知。
 */
export function isPrivilegedApproval(request) {
  const modes = [request?.requestedMode, request?.requested, request?.target, request?.effectiveMode, request?.mode];
  if (modes.some((mode) => typeof mode === 'string' && mode.trim().toLowerCase() === PRIVILEGED_MODE)) return true;
  const text = firstString(request?.justification, request?.reason, request?.description, request?.message) ?? '';
  return text.toLowerCase().includes(PRIVILEGED_MODE);
}

/**
 * 权限/批准请求 → 通知。
 * 事件载荷形态（DSH 0.2 实测）：`{ agent, callId, toolName, requestedMode,
 * effectiveMode, justification, subject, signal }`。
 *
 * @param {object} request - 审批请求
 * @param {string} lang - `zh` | `en`
 * @param {{guiOnly?: boolean}} [options] - `guiOnly`：因为高危而没给按钮，正文要说明去界面确认
 */
export function summarizeApproval(request, lang, options = {}) {
  const dict = dictionary(lang);
  const toolName = firstString(request?.toolName, request?.tool, request?.name) ?? 'DSH';
  const subject = approvalSubject(request, dict);
  const from = firstString(request?.effectiveMode, request?.mode, request?.currentMode);
  const to = firstString(request?.requestedMode, request?.requested, request?.target);
  const reason = firstString(request?.justification, request?.reason, request?.description, request?.message);

  const lines = [`${dict.toolLabel}: ${oneLine(toolName, 40)}`];
  if (from !== undefined || to !== undefined) {
    lines.push(`${dict.modeLabel}: ${oneLine(from ?? '?', 24)} → ${oneLine(to ?? '?', 24)}`);
  }
  lines.push(`${dict.reasonLabel}: ${oneLine(reason ?? dict.approvalNoReason, 180)}`);
  const session = sessionLabel(request?.agent);
  if (session !== undefined) lines.push(`${dict.sessionLabel}: ${session}`);

  const body = options.guiOnly === true
    ? `${dict.approvalBody(toolName, subject)} · ${dict.guiOnly}`
    : dict.approvalBody(toolName, subject);

  return {
    title: dict.approvalTitle,
    body: oneLine(body, 200),
    lines: lines.slice(0, 4),
    tag: 'dsh-approval',
    actionText: lang === 'en' ? 'Open DSH' : '打开 DSH',
  };
}

/** 提问请求 → 通知。载荷：`{ questions: [{ id, header?, question, options? }], agent }`。 */
export function summarizeQuestion(request, lang) {
  const dict = dictionary(lang);
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const first = questions[0] ?? {};
  const question = firstString(first.question, first.text, request?.question) ?? dict.questionBody;
  const header = firstString(first.header, first.title);
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) => firstString(option?.label, option?.value, option))
        .filter((value) => value !== undefined)
        .slice(0, 4)
    : [];

  const lines = [];
  if (header !== undefined && header !== question) lines.push(oneLine(header, 60));
  if (options.length > 0) lines.push(oneLine(dict.questionOptions(options.join(' / ')), 160));
  if (questions.length > 1) lines.push(dict.questionMore(questions.length - 1));
  const session = sessionLabel(request?.agent);
  if (session !== undefined) lines.push(`${dict.sessionLabel}: ${session}`);

  return {
    title: dict.questionTitle,
    body: oneLine(question, 200),
    lines: lines.slice(0, 4),
    tag: 'dsh-question',
    actionText: lang === 'en' ? 'Open DSH' : '打开 DSH',
  };
}

/** 一轮结束 → 通知。 */
export function summarizeTurnEnd(payload, lang) {
  const dict = dictionary(lang);
  const session = sessionLabel(payload?.agent);
  return {
    title: dict.turnEndTitle,
    body: dict.turnEndBody,
    lines: session !== undefined ? [`${dict.sessionLabel}: ${session}`] : [],
    tag: 'dsh-turn',
    actionText: lang === 'en' ? 'Open DSH' : '打开 DSH',
  };
}

/** 会话出错 → 通知。 */
export function summarizeError(payload, lang) {
  const dict = dictionary(lang);
  const error = payload?.error;
  const message = firstString(
    typeof error === 'string' ? error : undefined,
    error?.message,
    payload?.message,
  );
  const session = sessionLabel(payload?.agent);
  const lines = session !== undefined ? [`${dict.sessionLabel}: ${session}`] : [];
  return {
    title: dict.errorTitle,
    body: oneLine(message ?? dict.errorBody, 200),
    lines: lines.slice(0, 4),
    tag: 'dsh-error',
    actionText: lang === 'en' ? 'Open DSH' : '打开 DSH',
  };
}

/** AI/外部 API 自定义通知。 */
export function summarizeAgentNotification(args, lang) {
  const dict = dictionary(lang);
  return {
    title: oneLine(firstString(args?.title) ?? dict.agentToolTitle, 80),
    body: oneLine(firstString(args?.message, args?.body) ?? '', 300),
    lines: [],
    tag: firstString(args?.tag) ?? 'dsh-agent',
    actionText: lang === 'en' ? 'Open DSH' : '打开 DSH',
  };
}
