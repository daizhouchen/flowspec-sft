import catalog from './tool-catalog.json' with { type: 'json' };

export type ToolDefinition = { name: string; category: 'retrieval' | 'classification' | 'transformation' | 'reporting' | 'approval' | 'notification'; description: string; risk: 'read' | 'compute' | 'notify' | 'approval'; parameters: Record<string, { type: 'string' | 'integer' | 'boolean' | 'array' | 'object'; required: boolean; description: string }> };
export type WorkflowNode = { id: string; tool: string; arguments: Record<string, unknown>; depends_on: string[]; when?: string | null; requires_approval: boolean; retry: { max_attempts: number; backoff_seconds: number }; on_failure?: { tool: string; arguments: Record<string, unknown> } | null };
export type WorkflowSpec = { schema_version: '1.0'; name: string; description: string; trigger: { type: 'manual' | 'cron' | 'event'; expression?: string | null; event?: string | null }; nodes: WorkflowNode[] };
export type ValidationIssue = { code: string; level: 'error' | 'warning'; stage: 'schema' | 'dag' | 'tools'; message: string; node_id?: string; path?: string };
export type ValidationResult = { workflow: WorkflowSpec | null; valid: boolean; schema_valid: boolean; dag_valid: boolean; tools_valid: boolean; issues: ValidationIssue[]; topological_order: string[] };
export type Scenario = { risk: 'high' | 'medium' | 'low'; failures: Record<string, number | 'always'> };
export type ApprovalDecisions = Record<string, 'approve' | 'reject'>;
export type NodeStatus = 'pending' | 'succeeded' | 'waiting_approval' | 'rejected' | 'failed' | 'blocked' | 'skipped';
export type SimulationNode = { node_id: string; tool: string; status: NodeStatus; attempts: number; message: string; input_from?: string; output?: Record<string, unknown>; decision_key?: string; failure_handler?: { tool: string; status: NodeStatus; decision_key?: string; output?: Record<string, unknown> } };
export type TraceEvent = 'attempt' | 'succeeded' | 'failed' | 'retry' | 'waiting_approval' | 'approved' | 'rejected' | 'skipped' | 'blocked' | 'pending' | 'failure_handler';
export type SimulationResult = { status: 'completed' | 'waiting_approval' | 'failed' | 'invalid'; nodes: SimulationNode[]; trace: { index: number; node_id: string; tool: string; event: TraceEvent; attempt?: number; message: string; input_from?: string; output?: Record<string, unknown>; decision_key?: string }[]; validation: ValidationResult; scenario: Scenario; elapsed_ms: number };
export type CompilationResult = { workflow: WorkflowSpec | null; validation: ValidationResult; recognition: string[]; assumptions: string[]; unhandled: string[]; source: 'rules'; elapsed_ms: number };
export type WorkflowTemplate = { id: string; title: string; description: string; instruction: string; workflow: WorkflowSpec };
export const TOOL_CATALOG = catalog as unknown as ToolDefinition[];
export const DEFAULT_SCENARIO: Scenario = { risk: 'high', failures: {} };

const toolMap = new Map(TOOL_CATALOG.map(tool => [tool.name, tool]));
const copy = <T,>(value: T): T => structuredClone(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const conditionPattern = /^risk\s*(==|!=)\s*(high|medium|low)$/;
const negatedClause = /(?:不要|不需要|不用|不必|无需|禁止|取消|不得|停止|不再|不能|不可|不允许|不准|(?<!识)别(?:发送|发邮件|发通知|通知|发到|发给|发往|确认|审批|审核|分类|分析|检索|搜索|查询|生成|导出|翻译|汇总|聚合|重试|执行|运行|定时)|不(?:发送|发邮件|发通知|通知|发到|发给|发往|确认|审批|审核|分类|分析|检索|搜索|查询|生成|导出|翻译|汇总|聚合|重试|执行|运行|定时))/;
function node(id: string, tool: string, args: Record<string, unknown>, depends_on: string[] = [], options: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, tool, arguments: args, depends_on, requires_approval: false, retry: { max_attempts: 0, backoff_seconds: 0 }, ...options };
}
function spec(name: string, description: string, nodes: WorkflowNode[], trigger: WorkflowSpec['trigger'] = { type: 'manual' }): WorkflowSpec {
  return { schema_version: '1.0', name, description, trigger, nodes };
}
export const TEMPLATES: WorkflowTemplate[] = [
  { id: 'feedback', title: '客户反馈周报', description: '高风险先确认，低风险跳过风险审批；周报发送仍需单独确认。', instruction: '每周一汇总上周客户反馈，分类并识别风险；高风险先让负责人确认，再生成报告并发到产品群。失败时重试两次，仍失败则通知管理员。', workflow: spec('feedback_review', '客户反馈分类与风险确认，汇总周报；发送前单独确认。', [
    node('collect', 'feedback.search', { date_range: 'last_week', product: '演示产品' }, [], { retry: { max_attempts: 2, backoff_seconds: 2 }, on_failure: { tool: 'admin.notify', arguments: { message: '反馈检索失败，请人工核对。' } } }),
    node('classify', 'text.classify', { input_from: 'collect', labels: ['体验', '性能', '功能'] }, ['collect']),
    node('risk', 'risk.classify', { input_from: 'classify', threshold: 'high' }, ['classify']),
    node('approve', 'human.approval', { input_from: 'risk', assignee: '待填写的负责人' }, ['risk'], { requires_approval: true, when: 'risk == high' }),
    node('report', 'report.generate', { input_from: 'risk', template: 'weekly' }, ['risk', 'approve']),
    node('send', 'message.send', { input_from: 'report', channel: '待填写的产品群' }, ['report'], { requires_approval: true }),
  ], { type: 'cron', expression: '0 9 * * 1' }) },
  { id: 'knowledge', title: '资料报告与邮件审阅', description: '检索、摘要、报告，再审核邮件预览。所有内容与收件对象均为模拟。', instruction: '检索产品知识，摘要并生成报告，人工确认后发送邮件。', workflow: spec('knowledge_report', '检索知识、生成摘要与报告，确认后预览邮件。', [
    node('search', 'knowledge.search', { query: '待填写的资料主题', top_k: 5 }),
    node('summarize', 'text.summarize', { input_from: 'search', max_words: 200 }, ['search']),
    node('report', 'report.generate', { input_from: 'summarize', template: 'brief' }, ['summarize']),
    node('approve', 'human.approval', { input_from: 'report', assignee: '待填写的审阅人' }, ['report'], { requires_approval: true }),
    node('email', 'email.send', { input_from: 'report', recipient: 'reviewer@example.com' }, ['report', 'approve'], { requires_approval: true }),
  ]) },
  { id: 'parallel', title: '并行分析与失败兜底', description: '情感、风险两个分支分别完成后才生成报告；可注入失败观察重试和阻断。', instruction: '查询业务记录，并行情感分析与风险识别；汇总报告，负责人审批后发到业务群。', workflow: spec('parallel_review', '并行情感与风险节点，报告等待两条控制依赖，再确认通知。', [
    node('lookup', 'records.lookup', { record_type: '演示工单', filter: {} }, [], { retry: { max_attempts: 1, backoff_seconds: 1 }, on_failure: { tool: 'admin.notify', arguments: { message: '记录查询失败，需人工处理。' } } }),
    node('sentiment', 'sentiment.analyze', { input_from: 'lookup' }, ['lookup']),
    node('risk', 'risk.classify', { input_from: 'lookup', threshold: 'high' }, ['lookup']),
    node('report', 'report.generate', { input_from: 'sentiment', template: 'review' }, ['sentiment', 'risk']),
    node('approve', 'manager.approval', { input_from: 'report', role: '待填写的负责人' }, ['report'], { requires_approval: true }),
    node('send', 'message.send', { input_from: 'report', channel: '待填写的业务群' }, ['report', 'approve'], { requires_approval: true }),
  ]) },
];
export function getTemplate(id: string): WorkflowSpec {
  const value = TEMPLATES.find(item => item.id === id);
  if (!value) throw new Error('找不到此工作流模板。');
  return structuredClone(value.workflow);
}
function cronValid(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.length === 5 && fields.every((field, index) => field.split(',').every(part => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return false;
    const [min, max] = limits[index];
    if (match[2] && (+match[2] < 1 || +match[2] > max - min + 1)) return false;
    if (match[1] === '*') return true;
    const [from, to = from] = match[1].split('-').map(Number);
    return from >= min && to <= max && from <= to;
  }));
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 10000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(v => jsonValue(v, depth + 1));
  return plain(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([k, v]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && jsonValue(v, depth + 1));
}
export function validateWorkflow(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: string, stage: ValidationIssue['stage'], message: string, node_id?: string, path?: string, level: ValidationIssue['level'] = 'error') => issues.push({ code, stage, message, ...(node_id ? { node_id } : {}), ...(path ? { path } : {}), level });
  const shape = (value: unknown, keys: string[], path: string, id?: string): value is Record<string, unknown> => {
    if (!plain(value)) { add('schema_object', 'schema', `${path} 必须为对象。`, id, path); return false; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) add('unknown_field', 'schema', `${path} 不支持字段 ${key}。`, id, `${path}.${key}`);
    return true;
  };
  const invalid = (): ValidationResult => ({ workflow: null, valid: false, schema_valid: false, dag_valid: false, tools_valid: false, issues, topological_order: [] });
  if (!shape(raw, ['schema_version', 'name', 'description', 'trigger', 'nodes'], 'workflow')) return invalid();
  if ((raw.schema_version ?? '1.0') !== '1.0') add('schema_version', 'schema', '只支持 WorkflowSpec 1.0。', undefined, 'schema_version');
  if (typeof raw.name !== 'string' || raw.name.length < 3 || raw.name.length > 80 || !/^[a-z][a-z0-9_]+$/.test(raw.name)) add('workflow_name', 'schema', '工作流名称需为 3–80 位小写字母、数字、下划线，且以字母开头。', undefined, 'name');
  if (typeof raw.description !== 'string' || raw.description.trim().length < 2 || raw.description.length > 300) add('workflow_description', 'schema', '工作流说明需为 2–300 字。', undefined, 'description');
  const trigger = raw.trigger ?? { type: 'manual' };
  if (shape(trigger, ['type', 'expression', 'event'], 'trigger')) {
    if (!['manual', 'cron', 'event'].includes(trigger.type as string)) add('trigger_type', 'schema', '触发方式仅支持 manual / cron / event。', undefined, 'trigger.type');
    if (trigger.type === 'cron' && (!nonempty(trigger.expression) || !cronValid(trigger.expression))) add('trigger_cron', 'schema', '定时条件需为合法的五段 cron，例如 0 9 * * 1；此沙箱不提供定时调度。', undefined, 'trigger.expression');
    if (trigger.type === 'event' && (!nonempty(trigger.event) || trigger.event.length > 100)) add('trigger_event', 'schema', '事件触发需填写 1–100 字的事件名称。', undefined, 'trigger.event');
    if (trigger.type !== 'cron' && trigger.expression != null) add('unused_trigger', 'schema', '仅 cron 触发可填写 expression。', undefined, 'trigger.expression');
    if (trigger.type !== 'event' && trigger.event != null) add('unused_trigger', 'schema', '仅 event 触发可填写 event。', undefined, 'trigger.event');
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > 20) { add('nodes_length', 'schema', '工作流需包含 1–20 个节点。', undefined, 'nodes'); return invalid(); }
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  raw.nodes.forEach((value, index) => {
    const path = `nodes[${index}]`;
    if (!shape(value, ['id', 'tool', 'arguments', 'depends_on', 'when', 'requires_approval', 'retry', 'on_failure'], path)) return;
    const id = typeof value.id === 'string' ? value.id : undefined;
    if (!id || !/^[a-z][a-z0-9_]{1,31}$/.test(id)) add('node_id', 'schema', '节点 ID 需为 2–32 位小写字母、数字、下划线，且以字母开头。', id, `${path}.id`);
    if (id && seen.has(id)) add('duplicate_node_id', 'schema', `节点 ID 重复：${id}。`, id, `${path}.id`);
    if (id) seen.add(id);
    if (!nonempty(value.tool) || value.tool.length > 80) add('node_tool', 'schema', '节点必须指定工具 ID。', id, `${path}.tool`);
    const args = value.arguments ?? {}, deps = value.depends_on ?? [], retry = value.retry ?? { max_attempts: 0, backoff_seconds: 0 };
    if (!plain(args) || !jsonValue(args)) add('argument_shape', 'schema', '工具参数必须是有限大小的 JSON 对象。', id, `${path}.arguments`);
    if (!Array.isArray(deps) || deps.length > 20 || deps.some(d => !nonempty(d))) add('dependency_shape', 'schema', '依赖必须是节点 ID 数组，最多 20 项。', id, `${path}.depends_on`);
    if (value.when != null && (typeof value.when !== 'string' || !conditionPattern.test(value.when.trim()))) add('condition_syntax', 'schema', '仅支持 risk == high/medium/low 或 risk != high/medium/low，不执行任意表达式。', id, `${path}.when`);
    if (value.requires_approval !== undefined && typeof value.requires_approval !== 'boolean') add('approval_type', 'schema', 'requires_approval 必须为布尔值。', id, `${path}.requires_approval`);
    if (shape(retry, ['max_attempts', 'backoff_seconds'], `${path}.retry`, id)) {
      if (!Number.isInteger(retry.max_attempts ?? 0) || Number(retry.max_attempts ?? 0) < 0 || Number(retry.max_attempts ?? 0) > 3) add('retry_count', 'schema', '重试次数 max_attempts 必须为 0–3 的整数；初次尝试另计。', id, `${path}.retry.max_attempts`);
      if (!Number.isInteger(retry.backoff_seconds ?? 0) || Number(retry.backoff_seconds ?? 0) < 0 || Number(retry.backoff_seconds ?? 0) > 300) add('retry_backoff', 'schema', '重试等待需为 0–300 秒的整数。', id, `${path}.retry.backoff_seconds`);
    }
    const failure = value.on_failure;
    if (failure != null && shape(failure, ['tool', 'arguments'], `${path}.on_failure`, id)) {
      if (!nonempty(failure.tool) || failure.tool.length > 80) add('failure_tool', 'schema', '失败处理必须指定工具 ID。', id, `${path}.on_failure.tool`);
      if (!plain(failure.arguments ?? {}) || !jsonValue(failure.arguments ?? {})) add('failure_arguments', 'schema', '失败处理参数必须是有限大小的 JSON 对象。', id, `${path}.on_failure.arguments`);
    }
    if (!issues.some(item => item.stage === 'schema' && (item.node_id === id || item.path?.startsWith(path)))) nodes.push({ id: id!, tool: value.tool as string, arguments: copy(args as Record<string, unknown>), depends_on: [...deps as string[]], when: typeof value.when === 'string' ? value.when.trim() : null, requires_approval: value.requires_approval === true, retry: { max_attempts: (retry as Record<string, number>).max_attempts ?? 0, backoff_seconds: (retry as Record<string, number>).backoff_seconds ?? 0 }, on_failure: plain(failure) ? { tool: failure.tool as string, arguments: copy(failure.arguments as Record<string, unknown> ?? {}) } : null });
  });
  if (issues.some(item => item.stage === 'schema')) return invalid();
  const workflow = spec(raw.name as string, raw.description as string, nodes, copy(trigger as WorkflowSpec['trigger']));
  const ids = new Set(nodes.map(n => n.id));
  const ancestors = new Map<string, Set<string>>();
  const order: string[] = [], pending = new Set(ids);
  for (const n of nodes) {
    if (new Set(n.depends_on).size !== n.depends_on.length) add('duplicate_dependency', 'dag', '同一依赖不能重复。', n.id, 'depends_on');
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) add('dangling_dependency', 'dag', `依赖节点不存在：${dep}。`, n.id, 'depends_on');
      if (dep === n.id) add('self_dependency', 'dag', '节点不能依赖自身。', n.id, 'depends_on');
    }
  }
  while (pending.size) {
    const ready = nodes.filter(n => pending.has(n.id) && n.depends_on.every(dep => ids.has(dep) && !pending.has(dep)));
    if (!ready.length) break;
    for (const n of ready) { order.push(n.id); pending.delete(n.id); ancestors.set(n.id, new Set(n.depends_on.flatMap(dep => [dep, ...ancestors.get(dep) ?? []]))); }
  }
  if (pending.size && !issues.some(i => i.code === 'dangling_dependency')) add('cycle', 'dag', '工作流存在循环依赖。');
  function argumentsFor(toolId: string, args: Record<string, unknown>, n: WorkflowNode, failure = false) {
    const tool = toolMap.get(toolId), prefix = failure ? 'on_failure.arguments' : 'arguments';
    if (!tool) { add(failure ? 'unknown_failure_tool' : 'unknown_tool', 'tools', `未知工具：${toolId}。`, n.id, failure ? 'on_failure.tool' : 'tool'); return; }
    for (const key of Object.keys(args)) if (!Object.hasOwn(tool.parameters, key)) add('unknown_argument', 'tools', `${toolId} 不接受参数 ${key}。`, n.id, `${prefix}.${key}`);
    for (const [key, param] of Object.entries(tool.parameters)) {
      const value = args[key];
      if (value === undefined) { if (param.required) add('missing_argument', 'tools', `缺少必填参数：${key}。`, n.id, `${prefix}.${key}`); continue; }
      const valid = param.type === 'string' ? nonempty(value) : param.type === 'integer' ? Number.isSafeInteger(value) : param.type === 'boolean' ? typeof value === 'boolean' : param.type === 'array' ? Array.isArray(value) && value.length > 0 && value.every(nonempty) : plain(value);
      if (!valid) add('argument_type', 'tools', `${key} 需为${param.type}类型${param.type === 'string' || param.type === 'array' ? '且非空' : ''}。`, n.id, `${prefix}.${key}`);
      if ((key === 'top_k' || key === 'max_words') && typeof value === 'number' && value < 1) add('argument_range', 'tools', `${key} 必须为正整数。`, n.id, `${prefix}.${key}`);
    }
    const source = args.input_from;
    if (typeof source === 'string') {
      if (!ids.has(source)) add('dangling_input', 'tools', `输入节点不存在：${source}。`, n.id, `${prefix}.input_from`);
      else if (ancestors.has(n.id) && !ancestors.get(n.id)!.has(source)) add('non_upstream_input', 'tools', `数据输入 ${source} 必须是当前节点的真正上游，不能读取同层或自身。`, n.id, `${prefix}.input_from`);
    }
    if (tool.risk === 'notify' && (failure || !n.requires_approval)) add('approval_recommended', 'tools', failure ? '失败通知在沙箱运行时仍需单独确认。' : '通知建议标明人工确认；沙箱运行时会强制逐条确认。', n.id, failure ? 'on_failure' : 'requires_approval', 'warning');
  }
  for (const n of nodes) {
    argumentsFor(n.tool, n.arguments, n);
    if (n.on_failure) argumentsFor(n.on_failure.tool, n.on_failure.arguments, n, true);
    if (n.when && (!n.depends_on.length || (ancestors.has(n.id) && !nodes.some(source => source.tool === 'risk.classify' && ancestors.get(n.id)!.has(source.id))))) add('condition_source', 'tools', '风险条件必须有真正上游的 risk.classify 节点。', n.id, 'when');
  }
  return { workflow, valid: !issues.some(i => i.level === 'error'), schema_valid: true, dag_valid: !issues.some(i => i.stage === 'dag' && i.level === 'error'), tools_valid: !issues.some(i => i.stage === 'tools' && i.level === 'error'), issues, topological_order: pending.size ? [] : order };
}
export function compileInstruction(text: string): CompilationResult {
  const started = performance.now();
  const recognition: string[] = [], assumptions: string[] = [], unhandled: string[] = [];
  const finish = (workflow: WorkflowSpec | null): CompilationResult => ({ workflow, validation: workflow ? validateWorkflow(workflow) : { workflow: null, valid: false, schema_valid: false, dag_valid: false, tools_valid: false, issues: [{ code: 'unsupported_instruction', level: 'error', stage: 'schema', message: unhandled.join('；') || '尚无可用工作流。' }], topological_order: [] }, recognition, assumptions, unhandled, source: 'rules', elapsed_ms: Math.round((performance.now() - started) * 100) / 100 });
  if (typeof text !== 'string' || text.trim().length < 4 || text.length > 600) { unhandled.push('请填写 4–600 字的任务；空白不计为有效描述。'); return finish(null); }
  const clauses = text.split(/[，。；;\n]|但是|不过|但|(?=失败时|失败后|仍失败|最终失败|如果失败)/).map(value => value.trim()).filter(Boolean);
  const positive = (pattern: RegExp, includeFailure = false) => clauses.filter(clause => (includeFailure || !/(?:仍|最终|持续)?失败/.test(clause)) && pattern.test(clause) && !negatedClause.test(clause));
  const has = (pattern: RegExp) => positive(pattern).length > 0;
  const ignored = clauses.filter(clause => negatedClause.test(clause));
  if (ignored.length) assumptions.push(`未自动添加含否定要求的步骤：${ignored.join('；')}。如一句同时包含保留与禁止操作，请拆句确认。`);
  const nodes: WorkflowNode[] = [];
  if (has(/反馈/)) { nodes.push(node('collect', 'feedback.search', { date_range: 'last_week' })); recognition.push('客户反馈检索'); assumptions.push('反馈日期默认上周，可修改 date_range。'); }
  else if (has(/业务记录|工单|订单|记录查询|查询记录/)) { nodes.push(node('lookup', 'records.lookup', { record_type: '待确认的业务记录', filter: {} })); recognition.push('业务记录查询'); assumptions.push('记录类型与筛选条件需要在参数中确认。'); }
  else if (has(/检索|搜索|知识库|产品知识|查找资料/)) { nodes.push(node('search', 'knowledge.search', { query: positive(/检索|搜索|知识库|产品知识|查找资料/).join('；').slice(0, 300), top_k: 5 })); recognition.push('知识检索'); assumptions.push('检索词直接取原句，默认返回 5 条；请确认主题和数量。'); }
  if (!nodes.length) { unhandled.push('规则未识别到可用的数据来源。请明确检索知识、客户反馈或业务记录；也可从模板手工配置。'); return finish(null); }
  let source = nodes[0].id;
  let controls: string[] = [source];
  function append(id: string, tool: string, args: Record<string, unknown> = {}) {
    nodes.push(node(id, tool, { input_from: source, ...args }, [...new Set([source, ...controls])]));
    source = id; controls = [id]; recognition.push(toolMap.get(tool)!.description);
  }
  if (has(/(?<!风险)分类|产品模块|按模块/)) { append('classify', 'text.classify', { labels: ['体验', '性能', '其他'] }); assumptions.push('分类标签使用可修改的示例值。'); }
  const parallel = has(/并行|同时/) && has(/情感/) && has(/风险/);
  if (parallel) {
    const input = source;
    nodes.push(node('sentiment', 'sentiment.analyze', { input_from: input }, [input]), node('risk', 'risk.classify', { input_from: input, threshold: 'high' }, [input]));
    source = 'sentiment'; controls = ['sentiment', 'risk']; recognition.push('情感与风险两条并行依赖');
    assumptions.push('汇总读取 input_from 指定的一份数据，另一分支是控制依赖；没有伪造多输入融合。');
  } else {
    if (has(/情感/)) append('sentiment', 'sentiment.analyze');
    if (has(/风险/)) append('risk', 'risk.classify', { threshold: 'high' });
    if (has(/并行|同时/)) unhandled.push('当前规则仅自动编排情感与风险并行；其他并行关系请在依赖编辑器配置。');
  }
  const approval = has(/确认|审批|审核/);
  const conditionalApproval = approval && has(/高风险/) && nodes.some(n => n.id === 'risk');
  if (conditionalApproval) {
    nodes.push(node('approve', 'human.approval', { input_from: 'risk', assignee: '待填写的负责人' }, [...new Set([...controls, 'risk'])], { requires_approval: true, when: 'risk == high' }));
    controls = [...controls, 'approve']; recognition.push('高风险时人工确认，其他风险跳过该控制步骤');
  }
  if (has(/摘要|总结/)) { append('summarize', 'text.summarize', { max_words: 200 }); assumptions.push('摘要字数默认 200，可修改。'); }
  if (has(/聚合|分组统计/)) { append('aggregate', 'data.aggregate', { group_by: 'module' }); assumptions.push('聚合字段默认 module，可修改。'); }
  if (has(/翻译/)) { append('translate', 'content.translate', { target_language: has(/英文|英语/) ? 'en' : '待填写的目标语言' }); if (!has(/英文|英语/)) assumptions.push('未识别目标语言，请在翻译参数中填写。'); }
  if (has(/周报|报告/)) append('report', 'report.generate', { template: has(/周报/) ? 'weekly' : 'brief' });
  if (has(/图表/)) { append('chart', 'chart.render', { chart_type: 'bar' }); assumptions.push('图表默认柱状图，可修改。'); }
  if (has(/导出/)) { append('export', 'document.export', { format: has(/PDF|pdf/) ? 'pdf' : 'markdown' }); assumptions.push('导出节点只产生模拟文档预览，不代表已写入外部文件系统。'); }
  if (approval && !conditionalApproval) {
    const tool = has(/法务/) ? 'legal.review' : has(/负责人审批|经理审批/) ? 'manager.approval' : 'human.approval';
    const args = tool === 'human.approval' ? { assignee: '待填写的审阅人' } : tool === 'manager.approval' ? { role: '待填写的负责人' } : {};
    nodes.push(node('approve', tool, { input_from: source, ...args }, [...controls], { requires_approval: true }));
    controls = [...controls, 'approve']; recognition.push(toolMap.get(tool)!.description);
  }
  const notify = positive(/发送|通知|发到|发给|发往/);
  if (notify.length) {
    const request = notify.join('；');
    const tool = /邮件/.test(request) ? 'email.send' : /管理员/.test(request) ? 'admin.notify' : 'message.send';
    const args = tool === 'admin.notify' ? { message: '待确认的通知内容' } : { input_from: source, ...(tool === 'email.send' ? { recipient: 'reviewer@example.com' } : { channel: '待填写的群组' }) };
    nodes.push(node('send', tool, args, [...new Set([source, ...controls])], { requires_approval: true }));
    recognition.push('通知前单独确认'); assumptions.push('收件人、群组或通知正文是占位示例，必须人工核对；沙箱不会真实发送。');
  }
  const retryClause = clauses.find(c => /重试/.test(c) && !negatedClause.test(c));
  if (retryClause) {
    const match = /重试\s*([一二两三零\d]+)\s*次/.exec(retryClause);
    const values: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 零: 0 };
    const count = match ? values[match[1]] ?? Number(match[1]) : NaN;
    if (Number.isInteger(count) && count >= 0 && count <= 3) { for (const n of nodes) if (toolMap.get(n.tool)!.risk === 'read' || toolMap.get(n.tool)!.risk === 'compute') n.retry = { max_attempts: count, backoff_seconds: 2 }; recognition.push(`读取与计算节点失败后额外重试 ${count} 次`); assumptions.push('重试间隔示例为 2 秒，沙箱只记录计划时间，不实际等待。'); }
    else unhandled.push('重试需明确填写 0–3 次；未自动替换为其他次数。');
  }
  if (clauses.some(c => /失败/.test(c) && /通知管理员/.test(c) && !negatedClause.test(c))) {
    for (const n of nodes) if (toolMap.get(n.tool)!.risk === 'read' || toolMap.get(n.tool)!.risk === 'compute') n.on_failure = { tool: 'admin.notify', arguments: { message: `${n.id} 执行失败，请人工核对。` } };
    recognition.push('重试耗尽后的管理员通知分支（需单独确认）');
  }
  let trigger: WorkflowSpec['trigger'] = { type: 'manual' };
  const positiveSchedule = clauses.filter(clause => !negatedClause.test(clause)).join('；');
  const weekday = /每周([一二三四五六日天])/.exec(positiveSchedule);
  if (weekday) { const days: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }; trigger = { type: 'cron', expression: `0 9 * * ${days[weekday[1]]}` }; recognition.push(`每周${weekday[1]}定时配置`); assumptions.push('定时默认 09:00，cron 可修改；本机工作台不运行定时调度。'); }
  else if (/每天|每月|定时|每周/.test(positiveSchedule)) unhandled.push('该定时表达未自动解析，请手工填写 cron；当前保留手动触发。');
  for (const clause of positive(/删除|付款|支付|数据库写|真实发送|调用\s*API|金额|余额/)) unhandled.push(`未实现的操作或业务条件：${clause}`);
  if (has(/如果|否则|低风险|中风险/) && !conditionalApproval) unhandled.push('业务条件未转换为通用逻辑；仅支持以风险等级比较的显式条件，请检查节点 when。');
  assumptions.push('这是关键词规则生成的候选方案；未理解任意业务语义，请核对工具、参数和依赖后再演练。');
  return finish(spec('rule_workflow', text.slice(0, 300), nodes, trigger));
}
function simulatedOutput(tool: string, args: Record<string, unknown>, input: Record<string, unknown> | undefined, scenario: Scenario): Record<string, unknown> {
  const base = { simulated: true, source: 'browser_fixture', note: '以下是场景样本与确定性预览，未查询外部数据或调用模型。' };
  const items = Array.isArray(input?.items) ? input.items : [];
  if (tool === 'knowledge.search') return { ...base, query: args.query, items: [{ id: 'KB-01', title: '虚构产品资料', text: '示例资料用于核对后续数据来源。' }] };
  if (tool === 'feedback.search' || tool === 'records.lookup') return { ...base, items: [{ id: 'DEMO-01', module: '体验', text: '演示反馈：步骤说明不清晰。' }, { id: 'DEMO-02', module: '性能', text: '演示反馈：载入等待较长。' }], filter: args.filter ?? args.date_range ?? {} };
  if (tool === 'risk.classify') return { ...base, risk: scenario.risk, items, note: `风险取自本次手动场景：${scenario.risk}，不是模型分析结论。` };
  if (tool === 'text.classify') return { ...base, labels: args.labels, items: items.map((item, index) => ({ item, sample_label: (args.labels as string[])[index % (args.labels as string[]).length] })) };
  if (tool === 'sentiment.analyze') return { ...base, sample_sentiment: 'neutral', items, note: '固定中性样本，仅演练数据链，不代表真实情感分析。' };
  if (tool === 'data.aggregate') return { ...base, group_by: args.group_by ?? '(未指定)', sample_count: items.length, items };
  if (tool === 'content.translate') return { ...base, target_language: args.target_language, preview: '模拟译文占位，未完成实际翻译。', items };
  if (tool === 'text.summarize') return { ...base, preview: `模拟摘要：收到 ${items.length} 条样本。`, max_words: args.max_words ?? null, items };
  if (tool === 'chart.render') return { ...base, chart_type: args.chart_type, sample_count: items.length, items };
  if (tool === 'report.generate') return { ...base, template: args.template ?? '(未指定)', preview: '模拟报告：仅根据所选 input_from 的样本展示流程结果。', input, items };
  if (tool === 'document.export') return { ...base, format: args.format, preview: '模拟文档已形成，未写入外部系统。', input };
  if (toolMap.get(tool)?.risk === 'approval') return { ...base, approved: true, reviewed_input: input };
  return { ...base, destination: args.recipient ?? args.channel ?? '模拟管理员', preview: args.message ?? input?.preview ?? '模拟通知正文', sent: false };
}
export function simulateWorkflow(raw: unknown, scenario: Scenario = DEFAULT_SCENARIO, decisions: ApprovalDecisions = {}): SimulationResult {
  const started = performance.now();
  const validation = validateWorkflow(raw);
  const result: SimulationResult = { status: 'invalid', nodes: [], trace: [], validation, scenario: copy(DEFAULT_SCENARIO), elapsed_ms: 0 };
  const finish = () => { result.elapsed_ms = Math.round((performance.now() - started) * 100) / 100; return result; };
  if (!validation.valid || !validation.workflow) return finish();
  const workflow = validation.workflow;
  const invalidScenario = (message: string) => { validation.valid = false; validation.issues.push({ code: 'invalid_scenario', level: 'error', stage: 'tools', message }); validation.tools_valid = false; };
  const ids = new Set(workflow.nodes.map(n => n.id));
  if (!plain(scenario) || !['high', 'medium', 'low'].includes(scenario.risk) || !plain(scenario.failures) || Object.keys(scenario).some(k => k !== 'risk' && k !== 'failures')) invalidScenario('场景需要 high / medium / low 风险与当前节点的失败配置。');
  else for (const [id, count] of Object.entries(scenario.failures)) if (!ids.has(id) || (count !== 'always' && (!Number.isInteger(count) || count < 0 || count > 3))) invalidScenario('失败注入仅支持当前节点与前 0–3 次失败，或 always。');
  const decisionKeys = new Set(workflow.nodes.flatMap(n => [n.id, ...(n.on_failure ? [`${n.id}:failure`] : [])]));
  if (!plain(decisions) || Object.entries(decisions).some(([key, value]) => !decisionKeys.has(key) || !['approve', 'reject'].includes(value))) invalidScenario('审批决定包含未知节点或无效选项。');
  if (!validation.valid) return finish();
  result.scenario = copy(scenario);
  const states = new Map<string, SimulationNode>();
  const outputs = new Map<string, Record<string, unknown>>();
  const decisionFor = (key: string) => Object.hasOwn(decisions, key) ? decisions[key] : undefined;
  const emit = (n: WorkflowNode, event: TraceEvent, message: string, extra: Partial<SimulationResult['trace'][number]> = {}) => result.trace.push({ index: result.trace.length + 1, node_id: n.id, tool: n.tool, event, message, ...extra });
  for (const id of validation.topological_order) {
    const n = workflow.nodes.find(item => item.id === id)!;
    const tool = toolMap.get(n.tool)!;
    const source = typeof n.arguments.input_from === 'string' ? n.arguments.input_from : undefined;
    const state: SimulationNode = { node_id: id, tool: n.tool, status: 'pending', attempts: 0, message: '', ...(source ? { input_from: source } : {}) };
    states.set(id, state); result.nodes.push(state);
    const stop = (status: NodeStatus, message: string) => { state.status = status; state.message = message; emit(n, status as TraceEvent, message, source ? { input_from: source } : {}); };
    const dependencies = n.depends_on.map(dep => states.get(dep)!);
    if (dependencies.some(dep => ['failed', 'rejected', 'blocked'].includes(dep.status))) { stop('blocked', '上游失败或被拒绝，当前节点未尝试。'); continue; }
    if (dependencies.some(dep => dep.status === 'waiting_approval' || dep.status === 'pending')) { stop('pending', '等待上游确认；当前节点未尝试。'); continue; }
    if (n.when) {
      const upstream = new Set<string>();
      const walk = (nodeId: string) => { for (const dep of workflow.nodes.find(item => item.id === nodeId)!.depends_on) if (!upstream.has(dep)) { upstream.add(dep); walk(dep); } };
      walk(id);
      const riskAvailable = [...upstream].some(dep => outputs.get(dep)?.risk !== undefined && states.get(dep)?.tool === 'risk.classify');
      if (!riskAvailable) { stop('blocked', '风险条件没有成功产出的上游值，未使用场景值绕过数据来源。'); continue; }
      const [, operator, expected] = conditionPattern.exec(n.when)!;
      const matches = scenario.risk === expected;
      if (operator === '==' ? !matches : matches) { stop('skipped', `条件 ${n.when} 不成立，跳过此控制步骤。`); continue; }
    }
    if (source && states.get(source)?.status !== 'succeeded') { stop('blocked', `数据源 ${source} 没有成功输出；控制依赖跳过不等于产生数据。`); continue; }
    const input = source ? outputs.get(source) : undefined;
    if (n.requires_approval || tool.risk === 'notify' || tool.risk === 'approval') {
      state.decision_key = id;
      if (!decisionFor(id)) { state.status = 'waiting_approval'; state.message = '等待本节点的人工确认，尚未尝试。'; emit(n, 'waiting_approval', state.message, { decision_key: id }); continue; }
      if (decisionFor(id) === 'reject') { state.status = 'rejected'; state.message = '人工拒绝，当前节点未尝试。'; emit(n, 'rejected', state.message, { decision_key: id }); continue; }
      emit(n, 'approved', '已在本次模拟中确认；不代表真实系统授权。', { decision_key: id });
    }
    const injected = Object.hasOwn(scenario.failures, id) ? scenario.failures[id] : 0;
    for (let attempt = 1; attempt <= 1 + n.retry.max_attempts; attempt++) {
      state.attempts = attempt;
      emit(n, 'attempt', `第 ${attempt} 次模拟尝试。`, { attempt, ...(source ? { input_from: source } : {}) });
      if (injected === 'always' || attempt <= injected) {
        emit(n, 'failed', '命中本次场景的故障注入，未产生输出。', { attempt });
        if (attempt <= n.retry.max_attempts) { emit(n, 'retry', `计划等待 ${n.retry.backoff_seconds} 秒后重试；沙箱不实际计时等待。`, { attempt }); continue; }
        state.status = 'failed'; state.message = `共尝试 ${attempt} 次，重试已耗尽。`;
      } else {
        state.status = 'succeeded'; state.output = simulatedOutput(n.tool, n.arguments, input, scenario); state.message = '模拟步骤完成，未执行真实外部操作。'; outputs.set(id, state.output);
        emit(n, 'succeeded', state.message, { attempt, output: copy(state.output), ...(source ? { input_from: source } : {}) });
      }
      break;
    }
    if (state.status !== 'failed' || !n.on_failure) continue;
    const failure = n.on_failure, failureTool = toolMap.get(failure.tool)!;
    const failureSource = typeof failure.arguments.input_from === 'string' ? failure.arguments.input_from : undefined;
    state.failure_handler = { tool: failure.tool, status: 'pending' };
    if (failureSource && !outputs.has(failureSource)) { state.failure_handler.status = 'blocked'; emit(n, 'failure_handler', '失败处理所需数据尚未成功产出，处理器被阻断。', { tool: failure.tool }); continue; }
    if (failureTool.risk === 'notify' || failureTool.risk === 'approval') {
      const key = `${id}:failure`;
      state.failure_handler.decision_key = key; state.decision_key = key;
      if (!decisionFor(key)) { state.status = 'waiting_approval'; state.failure_handler.status = 'waiting_approval'; state.message = '主步骤已失败，等待确认失败处理；不是重试成功。'; emit(n, 'waiting_approval', state.message, { tool: failure.tool, decision_key: key }); continue; }
      if (decisionFor(key) === 'reject') { state.failure_handler.status = 'rejected'; emit(n, 'rejected', '已拒绝失败处理；主步骤仍失败。', { tool: failure.tool, decision_key: key }); continue; }
      emit(n, 'approved', '已确认本次模拟的失败处理。', { tool: failure.tool, decision_key: key });
    }
    state.failure_handler.status = 'succeeded';
    state.failure_handler.output = simulatedOutput(failure.tool, failure.arguments, failureSource ? outputs.get(failureSource) : undefined, scenario);
    emit(n, 'failure_handler', '失败处理已模拟完成；不会将失败的主步骤或后续依赖改为成功。', { tool: failure.tool, output: copy(state.failure_handler.output) });
  }
  result.status = result.nodes.some(n => n.status === 'waiting_approval' || n.status === 'pending') ? 'waiting_approval' : result.nodes.some(n => ['failed', 'blocked', 'rejected'].includes(n.status)) ? 'failed' : 'completed';
  return finish();
}
