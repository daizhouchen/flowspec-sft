import { validateWorkflow, simulateWorkflow, type WorkflowSpec, type Scenario, type ApprovalDecisions, type SimulationResult } from './workflow-domain.ts';

export type RunRecord = { id: string; startedAt: number; revision: number; workflow: WorkflowSpec; scenario: Scenario; decisions: Record<string, 'approve' | 'reject'> };
export type Plan = { schemaVersion: 1; id: string; title: string; brief: string; workflow: WorkflowSpec; origin: string; notes: string[]; revision: number; createdAt: number; updatedAt: number; runs: RunRecord[]; activeRunId: string | null };
export const WORKSPACE_LIMITS = { plans: 30, runs: 10, backupBytes: 2_000_000, depth: 16, values: 100_000 } as const;
const FORMAT = 'flowspec-plan';
const clone = <T,>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export class WorkspaceError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspaceError'; }
}
function fail(message: string): never { throw new WorkspaceError(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是数据对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}不是普通数据对象。`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}包含未知字段，请使用兼容版本打开，未丢弃任何数据。`);
}
function text(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) fail(`${label}为空、过长或格式无效。`);
  return required ? value.trim() : value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) fail('记录编号无效。');
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label}超出范围。`);
  return value;
}
function time(value: unknown, min = 0, max = Date.now() + 300_000): number { return integer(value, min, max, '记录时间'); }
function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}不是列表或数量超限。`);
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail(`${label}包含缺失项。`);
  return value;
}
function boundedJson(value: unknown): string {
  let count = 0;
  const parents = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++count > WORKSPACE_LIMITS.values || depth > WORKSPACE_LIMITS.depth) fail('备份结构过大或嵌套过深。');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || parents.has(item)) fail('备份含循环引用或无法保存的数据。');
    if (!Array.isArray(item)) record(item, '备份字段');
    else array(item, WORKSPACE_LIMITS.values, '备份列表');
    if (Object.getOwnPropertySymbols(item).length) fail('备份含无法保存的 Symbol 字段。');
    parents.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (Array.isArray(item) && !/^(?:0|[1-9]\d*)$/u.test(key)) fail('备份列表含无法保存的附加字段。');
      if (!('value' in descriptor) || !descriptor.enumerable) fail('备份含不支持的访问器或隐藏字段。');
      visit(descriptor.value, depth + 1);
    }
    parents.delete(item);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > WORKSPACE_LIMITS.backupBytes) fail('单个方案备份超过 2 MB，请减少运行记录或拆分方案。');
  return serialized;
}
function readWorkflow(raw: unknown): WorkflowSpec {
  const validation = validateWorkflow(raw);
  if (!validation.schema_valid || !validation.workflow) fail(validation.issues.filter(issue => issue.stage === 'schema').map(issue => issue.message).join('；') || '工作流结构无效。');
  return clone(validation.workflow);
}
function readScenario(raw: unknown, workflow: WorkflowSpec): Scenario {
  const value = record(raw, '模拟场景');
  keys(value, ['risk', 'failures'], '模拟场景');
  if (!['high', 'medium', 'low'].includes(value.risk as string)) fail('模拟风险等级无效。');
  const rawFailures = record(value.failures, '失败注入');
  const failures: Scenario['failures'] = {};
  for (const [nodeId, failure] of Object.entries(rawFailures)) {
    if (!workflow.nodes.some(node => node.id === nodeId)) fail('失败注入引用了不存在的节点。');
    failures[nodeId] = failure === 'always' ? 'always' : integer(failure, 0, 3, '模拟失败次数');
  }
  return { risk: value.risk as Scenario['risk'], failures };
}
function waiting(result: SimulationResult): { nodeId: string; key: string }[] {
  const values: { nodeId: string; key: string }[] = [];
  for (const node of result.nodes) {
    if (node.status === 'waiting_approval') values.push({ nodeId: node.node_id, key: node.decision_key ?? node.node_id });
    if (node.failure_handler?.status === 'waiting_approval') values.push({ nodeId: node.node_id, key: node.failure_handler.decision_key ?? `${node.node_id}:failure` });
  }
  return values;
}
function readDecisions(raw: unknown, workflow: WorkflowSpec, scenario: Scenario): ApprovalDecisions {
  const value = record(raw, '审批决定');
  if (Object.keys(value).length > workflow.nodes.length * 2) fail('审批决定数量超限。');
  const remaining = new Map(Object.entries(value));
  for (const decision of remaining.values()) if (decision !== 'approve' && decision !== 'reject') fail('审批决定必须是通过或拒绝。');
  const decisions: ApprovalDecisions = {};
  while (remaining.size) {
    const available = waiting(simulateWorkflow(workflow, scenario, decisions));
    const next = available.find(item => remaining.has(item.key));
    if (!next) fail('审批决定不对应可到达的待审批步骤。');
    decisions[next.key] = remaining.get(next.key) as 'approve' | 'reject';
    remaining.delete(next.key);
  }
  return decisions;
}
function finalized(plan: Plan): Plan { boundedJson({ format: FORMAT, schemaVersion: 1, plan }); return plan; }

export function createPlan(workflow: WorkflowSpec, input: { title: string; brief?: string; origin?: string; notes?: string[] }, now = Date.now()): Plan {
  time(now);
  const canonical = readWorkflow(workflow);
  return finalized({ schemaVersion: 1, id: crypto.randomUUID(), title: text(input.title, 120, '方案名称', true),
    brief: text(input.brief ?? '', 6_000, '需求描述'), workflow: canonical, origin: text(input.origin ?? 'manual', 80, '方案来源', true),
    notes: array(input.notes ?? [], 30, '说明').map(note => text(note, 2_000, '说明')), revision: 1,
    createdAt: now, updatedAt: now, runs: [], activeRunId: null });
}
export function updatePlan(plan: Plan, patch: { title?: string; brief?: string; workflow?: WorkflowSpec }, now = Date.now()): Plan {
  time(now, plan.updatedAt);
  const workflow = patch.workflow === undefined ? clone(plan.workflow) : readWorkflow(patch.workflow);
  const brief = patch.brief === undefined ? plan.brief : text(patch.brief, 6_000, '需求描述');
  const changed = !equal(workflow, plan.workflow) || brief !== plan.brief;
  return finalized({ ...clone(plan), title: patch.title === undefined ? plan.title : text(patch.title, 120, '方案名称', true),
    workflow, brief, revision: changed ? integer(plan.revision + 1, 1, Number.MAX_SAFE_INTEGER, '方案版本') : plan.revision,
    activeRunId: changed ? null : plan.activeRunId, updatedAt: now });
}
export function clonePlan(plan: Plan, now = Date.now(), keepRuns = false): Plan {
  time(now, plan.updatedAt);
  const copied = validateBackup(plan);
  return finalized({ ...copied, id: crypto.randomUUID(), title: keepRuns ? copied.title : `${copied.title.slice(0, 114)}（副本）`,
    revision: keepRuns ? copied.revision : 1, createdAt: keepRuns ? copied.createdAt : now, updatedAt: now,
    runs: keepRuns ? copied.runs : [], activeRunId: keepRuns ? copied.activeRunId : null });
}
export function startRun(plan: Plan, scenario: Scenario, now = Date.now()): Plan {
  time(now, plan.updatedAt);
  const validation = validateWorkflow(plan.workflow);
  if (!validation.valid || !validation.workflow) fail('请先修正工作流校验错误，再开始模拟。');
  const record: RunRecord = { id: crypto.randomUUID(), startedAt: now, revision: plan.revision,
    workflow: clone(validation.workflow), scenario: readScenario(scenario, validation.workflow), decisions: {} };
  return finalized({ ...clone(plan), runs: [record, ...clone(plan.runs)].slice(0, WORKSPACE_LIMITS.runs), activeRunId: record.id, updatedAt: now });
}
export function decideRun(plan: Plan, nodeId: string, decision: 'approve' | 'reject', now = Date.now()): Plan {
  time(now, plan.updatedAt);
  if (decision !== 'approve' && decision !== 'reject') fail('审批决定无效。');
  const run = plan.runs.find(item => item.id === plan.activeRunId);
  if (!run || run.revision !== plan.revision || !equal(run.workflow, plan.workflow)) fail('只有当前方案版本的活动模拟可以继续审批。');
  const target = waiting(simulateWorkflow(run.workflow, run.scenario, run.decisions)).find(item => item.key === nodeId || item.nodeId === nodeId);
  if (!target) fail('此步骤当前没有等待审批，未记录决定。');
  return finalized({ ...clone(plan), runs: plan.runs.map(item => item.id === run.id
    ? { ...clone(item), decisions: { ...item.decisions, [target.key]: decision } } : clone(item)), updatedAt: now });
}

export function validateBackup(raw: unknown): Plan {
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > WORKSPACE_LIMITS.backupBytes) fail('备份文件超过 2 MB 上限。');
    try { raw = JSON.parse(raw); } catch { fail('备份不是有效的 JSON 文件。'); }
  }
  boundedJson(raw);
  let value = record(raw, '方案');
  if (value.format !== undefined) {
    keys(value, ['format', 'schemaVersion', 'plan'], '备份包装');
    if (value.format !== FORMAT || value.schemaVersion !== 1) fail('备份格式或版本不受支持。');
    value = record(value.plan, '方案');
  }
  keys(value, ['schemaVersion', 'id', 'title', 'brief', 'workflow', 'origin', 'notes', 'revision', 'createdAt', 'updatedAt', 'runs', 'activeRunId'], '方案');
  if (value.schemaVersion !== 1) fail('方案数据版本不受支持。');
  const createdAt = time(value.createdAt);
  const updatedAt = time(value.updatedAt, createdAt);
  const workflow = readWorkflow(value.workflow);
  const revision = integer(value.revision, 1, Number.MAX_SAFE_INTEGER, '方案版本');
  const planId = id(value.id);
  const used = new Set<string>([planId]);
  let latestTime = updatedAt;
  let latestRevision = revision;
  const runs: RunRecord[] = array(value.runs, WORKSPACE_LIMITS.runs, '运行记录').map(rawRun => {
    const run = record(rawRun, '运行记录');
    keys(run, ['id', 'startedAt', 'revision', 'workflow', 'scenario', 'decisions'], '运行记录');
    const runId = id(run.id);
    if (used.has(runId)) fail('方案或运行编号重复。');
    used.add(runId);
    const startedAt = time(run.startedAt, createdAt, latestTime);
    const runRevision = integer(run.revision, 1, latestRevision, '运行版本');
    latestTime = startedAt; latestRevision = runRevision;
    const snapshot = readWorkflow(run.workflow);
    if (!validateWorkflow(snapshot).valid) fail('运行快照包含无法模拟的工作流。');
    if (runRevision === revision && !equal(snapshot, workflow)) fail('当前版本的运行快照与方案工作流不一致。');
    const scenario = readScenario(run.scenario, snapshot);
    return { id: runId, startedAt, revision: runRevision, workflow: snapshot, scenario, decisions: readDecisions(run.decisions, snapshot, scenario) };
  });
  const activeRunId = value.activeRunId === null ? null : id(value.activeRunId);
  if (activeRunId !== null && !runs.some(run => run.id === activeRunId && run.revision === revision)) fail('活动运行不存在或属于旧版本。');
  return finalized({ schemaVersion: 1, id: planId, title: text(value.title, 120, '方案名称', true), brief: text(value.brief, 6_000, '需求描述'),
    origin: text(value.origin, 80, '方案来源', true), notes: array(value.notes, 30, '说明').map(note => text(note, 2_000, '说明')),
    workflow, revision, createdAt, updatedAt, runs, activeRunId });
}
export function serializeBackup(plan: Plan): string {
  const validated = validateBackup(plan);
  return boundedJson({ format: FORMAT, schemaVersion: 1, plan: validated });
}
export function exportHandoff(plan: Plan, record?: RunRecord): string {
  const validated = validateBackup(plan);
  const selected = record ? validated.runs.find(run => run.id === record.id) : validated.runs.find(run => run.id === validated.activeRunId);
  if (record && !selected) fail('选定运行不属于此方案。');
  const workflow = selected?.workflow ?? validated.workflow;
  const validation = validateWorkflow(workflow);
  const lines = [`# ${validated.title.replace(/[\r\n]+/gu, ' ')} — 模拟交接说明`, '',
    '此文档记录本机流程设计与沙箱模拟；没有执行真实外部操作，审批决定也只用于此次模拟。', '',
    `方案版本：${validated.revision}；当前工作流校验：${validateWorkflow(validated.workflow).valid ? '通过' : '待修正'}。`,
    `需求：${validated.brief || '未填写'}`, '', ...validated.notes.map(note => `说明：${note}`), ''];
  if (selected) {
    const simulation = simulateWorkflow(selected.workflow, selected.scenario, selected.decisions);
    lines.push(`选定运行：${selected.id}；快照版本：${selected.revision}；模拟结果：${simulation.status}。`, '',
      `模拟场景：${JSON.stringify(selected.scenario)}`, `模拟审批决定：${JSON.stringify(selected.decisions)}`, '', '## 模拟轨迹', '');
    for (const step of simulation.trace) lines.push(`${step.index}. ${step.node_id} / ${step.tool} / ${step.event}${step.attempt === undefined ? '' : ` / 尝试 ${step.attempt}`}：${step.message}`);
  } else lines.push('尚未选定模拟运行；以下仅为当前方案定义。');
  if (validation.issues.length) lines.push('', '## 校验提示', '', ...validation.issues.map(issue => `- ${issue.level} / ${issue.code}：${issue.message}`));
  const json = JSON.stringify(workflow, null, 2);
  const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/gu)].map(match => match[0].length + 1)));
  lines.push('', selected ? '## 选定运行的工作流快照' : '## 当前工作流定义', '', `${fence}json`, json, fence, '');
  return lines.join('\n');
}
