import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_CATALOG, TEMPLATES, getTemplate, validateWorkflow, compileInstruction, simulateWorkflow,
} from '../src/workflow-domain.ts';

const clone = value => structuredClone(value);
const scene = (risk = 'high', failures = {}) => ({ risk, failures });
const row = (run, id) => run.nodes.find(item => item.node_id === id);
const errors = raw => validateWorkflow(raw).issues.filter(item => item.level === 'error');
const simple = () => ({ schema_version: '1.0', name: 'simple_search', description: '查找演示资料', trigger: { type: 'manual' }, nodes: [
  { id: 'search', tool: 'knowledge.search', arguments: { query: '演示主题', top_k: 5 }, depends_on: [], requires_approval: false, retry: { max_attempts: 0, backoff_seconds: 0 } },
] });

test('all templates preserve the Python tool vocabulary and return independent editable specs', () => {
  assert.equal(TOOL_CATALOG.length, 18);
  assert.equal(new Set(TOOL_CATALOG.map(t => t.name)).size, 18);
  assert.equal(TEMPLATES.length, 3);
  for (const template of TEMPLATES) {
    const workflow = getTemplate(template.id);
    assert.equal(validateWorkflow(workflow).valid, true);
    workflow.nodes[0].arguments.changed = true;
    assert.equal(Object.hasOwn(getTemplate(template.id).nodes[0].arguments, 'changed'), false);
  }
  assert.throws(() => getTemplate('missing'), /找不到/);
});

test('schema errors are distinguished from graph/tool errors and defaults do not mutate input', () => {
  for (const raw of [null, [], 'json', { ...simple(), unexpected: true }, { ...simple(), nodes: [] }, { ...simple(), name: 'BAD NAME' }]) {
    const result = validateWorkflow(raw);
    assert.equal(result.valid, false);
    assert.equal(result.schema_valid, false);
    assert.equal(result.workflow, null);
    assert.ok(result.issues.some(i => i.stage === 'schema'));
  }
  const raw = simple(); delete raw.nodes[0].retry; delete raw.nodes[0].requires_approval;
  const before = clone(raw), result = validateWorkflow(raw);
  assert.equal(result.valid, true);
  assert.deepEqual(result.workflow.nodes[0].retry, { max_attempts: 0, backoff_seconds: 0 });
  assert.deepEqual(raw, before);
});

test('tool parameters enforce declared types, required values and unknown fields including failures', () => {
  for (const mutate of [
    w => { w.nodes[0].tool = 'invented.tool'; },
    w => { w.nodes[0].arguments.query = {}; },
    w => { w.nodes[0].arguments.query = '  '; },
    w => { w.nodes[0].arguments.top_k = '5'; },
    w => { w.nodes[0].arguments.top_k = true; },
    w => { w.nodes[0].arguments.top_k = 0; },
    w => { delete w.nodes[0].arguments.query; },
    w => { w.nodes[0].arguments.url = 'https://example.invalid'; },
    w => { w.nodes[0].on_failure = { tool: 'admin.notify', arguments: { message: [] } }; },
  ]) {
    const w = simple(); mutate(w);
    const result = validateWorkflow(w);
    assert.equal(result.schema_valid, true, mutate.toString());
    assert.equal(result.tools_valid, false, mutate.toString());
    assert.equal(result.valid, false);
  }
  const labels = getTemplate('feedback'); labels.nodes[1].arguments.labels = [];
  assert.ok(errors(labels).some(i => i.code === 'argument_type'));
});

test('duplicate, missing, self and cyclic dependencies cannot be called a valid DAG', () => {
  for (const mutate of [
    w => { w.nodes[1].depends_on = ['search', 'search']; },
    w => { w.nodes[1].depends_on = ['missing']; },
    w => { w.nodes[1].depends_on = ['summarize']; },
    w => { w.nodes[0].depends_on = ['summarize']; },
  ]) {
    const w = getTemplate('knowledge'); mutate(w);
    const result = validateWorkflow(w);
    assert.equal(result.valid, false);
    assert.equal(result.dag_valid, false, mutate.toString());
  }
  const w = simple(); w.nodes.push(clone(w.nodes[0]));
  assert.ok(errors(w).some(i => i.code === 'duplicate_node_id'));
});

test('data input must be a real ancestor and cannot bypass checks with the wrong type', () => {
  const w = getTemplate('parallel');
  for (const source of ['missing', 'report', 'risk', [], 5]) {
    const bad = clone(w); bad.nodes.find(n => n.id === 'sentiment').arguments.input_from = source;
    assert.equal(validateWorkflow(bad).valid, false, JSON.stringify(source));
  }
  const bad = clone(w);
  bad.nodes[0].on_failure = { tool: 'report.generate', arguments: { input_from: 'lookup' } };
  assert.ok(errors(bad).some(i => i.code === 'non_upstream_input' && i.path.includes('on_failure')));
});

test('only supported risk comparisons with a real upstream classifier are executable', () => {
  const w = getTemplate('feedback');
  for (const when of ['false', 'risk = high', 'risk == urgent', 'globalThis.compromised = true', '   ']) {
    const bad = clone(w); bad.nodes.find(n => n.id === 'approve').when = when;
    assert.ok(errors(bad).some(i => i.code === 'condition_syntax'));
  }
  const bad = getTemplate('knowledge'); bad.nodes[1].when = 'risk == high';
  assert.ok(errors(bad).some(i => i.code === 'condition_source'));
  const different = clone(w); different.nodes.find(n => n.id === 'approve').when = 'risk != low';
  assert.equal(validateWorkflow(different).valid, true);
});

test('trigger and retry schemas refuse unusable schedules and out-of-bounds controls', () => {
  for (const trigger of [{ type: 'cron' }, { type: 'cron', expression: '99 24 * * 9' }, { type: 'cron', expression: '* * * * */0' }, { type: 'event', event: ' ' }, { type: 'manual', expression: '* * * * *' }]) {
    assert.equal(validateWorkflow({ ...simple(), trigger }).valid, false);
  }
  for (const expression of ['0 9 * * 1', '*/15 9-17 * * 1-5', '0,30 10 * 1,6 0']) assert.equal(validateWorkflow({ ...simple(), trigger: { type: 'cron', expression } }).valid, true);
  for (const retry of [{ max_attempts: 4, backoff_seconds: 0 }, { max_attempts: -1, backoff_seconds: 0 }, { max_attempts: 1, backoff_seconds: 301 }, { max_attempts: 1.5, backoff_seconds: 0 }]) {
    const w = simple(); w.nodes[0].retry = retry;
    assert.equal(validateWorkflow(w).valid, false);
  }
});

test('unknown instructions are refused and negated sending never creates a notification', () => {
  for (const instruction of ['今天天气怎么样', '请删除所有文件', '    ', 'x'.repeat(601)]) {
    const result = compileInstruction(instruction);
    assert.equal(result.workflow, null);
    assert.equal(result.validation.valid, false);
    assert.ok(result.unhandled.length);
  }
  const noSend = compileInstruction('检索产品知识并生成报告，不要发送邮件。');
  assert.equal(noSend.validation.valid, true);
  assert.equal(noSend.workflow.nodes.some(n => n.tool.endsWith('.send')), false);
  assert.ok(noSend.assumptions.some(text => text.includes('否定')));
  const group = compileInstruction('检索知识并发到产品群，不要发邮件。');
  assert.equal(group.workflow.nodes.at(-1).tool, 'message.send');
  assert.equal(compileInstruction('检索开发资料。').workflow.nodes.length, 1, '开发 does not match the old single 发 send trigger');
  for (const clause of ['不发送邮件', '不能发送邮件', '不可发送邮件', '不发邮件', '不通知管理员', '不允许发到产品群', '不得发给用户', '别发送邮件']) {
    const result = compileInstruction(`检索知识并生成报告，${clause}。`);
    assert.equal(result.validation.valid, true, clause);
    assert.equal(result.workflow.nodes.some(n => ['email.send', 'message.send', 'admin.notify'].includes(n.tool)), false, clause);
  }
  const noFailure = compileInstruction('检索知识。失败后不重试，不通知管理员。不要每周一定时。');
  assert.equal(noFailure.workflow.nodes[0].retry.max_attempts, 0);
  assert.equal(noFailure.workflow.nodes.some(n => n.on_failure), false);
  assert.deepEqual(noFailure.workflow.trigger, { type: 'manual' });
  const failedNoNotification = compileInstruction('检索知识，失败后不能通知管理员。');
  assert.equal(failedNoNotification.workflow.nodes.some(n => n.on_failure), false);
  const recognition = compileInstruction('汇总上周客户反馈，按模块分类，识别高风险问题后请负责人确认，再生成周报。');
  assert.equal(recognition.validation.valid, true);
  assert.equal(recognition.workflow.nodes.find(n => n.tool === 'human.approval')?.when, 'risk == high');
  assert.ok(recognition.workflow.nodes.some(n => n.tool === 'risk.classify'), '识别 is not the negative imperative 别');
  assert.equal(recognition.assumptions.some(s => s.includes('否定')), false);
});

test('rule compilation exposes defaults, partial coverage, actual retry count and no fake failure node', () => {
  const result = compileInstruction('每周一检索知识，生成报告。失败时重试三次，仍失败则通知管理员。');
  assert.equal(result.source, 'rules');
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.workflow.trigger, { type: 'cron', expression: '0 9 * * 1' });
  assert.equal(result.workflow.nodes[0].retry.max_attempts, 3);
  assert.equal(result.workflow.nodes[0].on_failure.tool, 'admin.notify');
  assert.equal(result.workflow.nodes.some(n => n.tool === 'admin.notify'), false);
  assert.ok(result.assumptions.some(s => s.includes('09:00')));
  assert.ok(result.recognition.length);
  const partial = compileInstruction('检索知识，随后删除数据库记录。失败后重试九次。');
  assert.ok(partial.unhandled.some(s => s.includes('删除')));
  assert.ok(partial.unhandled.some(s => s.includes('重试')));
  assert.equal(partial.workflow.nodes[0].retry.max_attempts, 0);
});

test('high risk waits for per-node approval and notification confirmation, then completes only simulated output', () => {
  const w = getTemplate('feedback');
  const first = simulateWorkflow(w, scene('high'));
  assert.equal(first.status, 'waiting_approval');
  assert.equal(row(first, 'approve').status, 'waiting_approval');
  assert.equal(row(first, 'report').status, 'pending');
  assert.equal(row(first, 'send').attempts, 0);
  const second = simulateWorkflow(w, scene('high'), { approve: 'approve' });
  assert.equal(row(second, 'report').status, 'succeeded');
  assert.equal(row(second, 'send').decision_key, 'send');
  const final = simulateWorkflow(w, scene('high'), { approve: 'approve', send: 'approve' });
  assert.equal(final.status, 'completed');
  assert.equal(row(final, 'send').output.sent, false);
  assert.equal(row(final, 'risk').output.risk, 'high');
  assert.match(row(final, 'risk').output.note, /手动场景/);
});

test('low/medium risk skip conditional control approval but never invent a skipped data output', () => {
  for (const risk of ['low', 'medium']) {
    const run = simulateWorkflow(getTemplate('feedback'), scene(risk));
    assert.equal(row(run, 'approve').status, 'skipped');
    assert.equal(row(run, 'report').status, 'succeeded');
    assert.equal(row(run, 'send').status, 'waiting_approval');
    const badData = getTemplate('feedback'); badData.nodes.find(n => n.id === 'report').arguments.input_from = 'approve';
    assert.equal(validateWorkflow(badData).valid, true);
    const blocked = simulateWorkflow(badData, scene(risk));
    assert.equal(row(blocked, 'report').status, 'blocked');
    assert.equal(row(blocked, 'report').output, undefined);
    assert.equal(row(blocked, 'send').status, 'blocked');
  }
});

test('notification warning never bypasses runtime approval and rejection blocks all dependants', () => {
  const w = getTemplate('knowledge');
  w.nodes.find(n => n.id === 'email').requires_approval = false;
  assert.equal(validateWorkflow(w).valid, true);
  assert.ok(validateWorkflow(w).issues.some(i => i.code === 'approval_recommended' && i.level === 'warning'));
  assert.equal(row(simulateWorkflow(w, scene(), { approve: 'approve' }), 'email').status, 'waiting_approval');
  const rejected = simulateWorkflow(w, scene(), { approve: 'reject' });
  assert.equal(row(rejected, 'approve').status, 'rejected');
  assert.equal(row(rejected, 'email').status, 'blocked');
  assert.equal(rejected.status, 'failed');
  const flagged = simple(); flagged.nodes[0].requires_approval = true;
  assert.equal(row(simulateWorkflow(flagged), 'search').status, 'waiting_approval');
});

test('failure injection performs real attempt/retry transitions and can recover on the final attempt', () => {
  const w = getTemplate('feedback');
  const run = simulateWorkflow(w, scene('low', { collect: 2 }));
  assert.equal(row(run, 'collect').attempts, 3);
  assert.equal(row(run, 'collect').status, 'succeeded');
  assert.deepEqual(run.trace.filter(t => t.node_id === 'collect').map(t => t.event), ['attempt', 'failed', 'retry', 'attempt', 'failed', 'retry', 'attempt', 'succeeded']);
  assert.equal(run.trace.some(t => t.event === 'failure_handler'), false);
  const noRetry = simple();
  const failed = simulateWorkflow(noRetry, scene('high', { search: 1 }));
  assert.equal(row(failed, 'search').attempts, 1);
  assert.equal(failed.status, 'failed');
});

test('exhausted retries invoke a separately approved failure handler without repairing the failed main branch', () => {
  const w = getTemplate('feedback');
  const waiting = simulateWorkflow(w, scene('low', { collect: 'always' }));
  assert.equal(row(waiting, 'collect').attempts, 3);
  assert.equal(row(waiting, 'collect').decision_key, 'collect:failure');
  assert.equal(row(waiting, 'collect').failure_handler.status, 'waiting_approval');
  assert.equal(row(waiting, 'classify').status, 'pending');
  const finished = simulateWorkflow(w, scene('low', { collect: 'always' }), { 'collect:failure': 'approve' });
  assert.equal(finished.status, 'failed');
  assert.equal(row(finished, 'collect').status, 'failed');
  assert.equal(row(finished, 'collect').failure_handler.status, 'succeeded');
  assert.equal(row(finished, 'collect').failure_handler.output.sent, false);
  assert.equal(row(finished, 'classify').status, 'blocked');
  assert.equal(row(finished, 'collect').output, undefined);
  const rejected = simulateWorkflow(w, scene('low', { collect: 'always' }), { 'collect:failure': 'reject' });
  assert.equal(row(rejected, 'collect').failure_handler.status, 'rejected');
  assert.equal(rejected.status, 'failed');
});

test('a failed parallel branch blocks its join while an independent sibling still runs', () => {
  const run = simulateWorkflow(getTemplate('parallel'), scene('high', { risk: 'always' }));
  assert.equal(row(run, 'sentiment').status, 'succeeded');
  assert.equal(row(run, 'risk').status, 'failed');
  assert.equal(row(run, 'report').status, 'blocked');
  assert.equal(row(run, 'report').attempts, 0);
  assert.equal(run.status, 'failed');
});

test('all 18 virtual tools produce explicit simulated outputs through valid data dependencies', () => {
  for (const tool of TOOL_CATALOG) {
    const w = simple();
    const args = Object.fromEntries(Object.entries(tool.parameters).filter(([, param]) => param.required).map(([key, param]) => [key, key === 'input_from' ? 'search' : param.type === 'string' ? '演示值' : param.type === 'array' ? ['演示标签'] : param.type === 'integer' ? 1 : param.type === 'boolean' ? true : {}]));
    w.nodes.push({ id: 'target', tool: tool.name, arguments: args, depends_on: ['search'], requires_approval: false, retry: { max_attempts: 0, backoff_seconds: 0 } });
    assert.equal(validateWorkflow(w).valid, true, tool.name);
    const run = simulateWorkflow(w, scene(), { target: 'approve' });
    assert.equal(row(run, 'target').status, 'succeeded', tool.name);
    assert.equal(row(run, 'target').output.simulated, true, tool.name);
    assert.deepEqual(JSON.parse(JSON.stringify(row(run, 'target').output)), row(run, 'target').output, 'outputs contain only round-trippable JSON');
  }
});

test('invalid scenarios, foreign decisions and unsafe workflow shapes cannot produce a successful trace', () => {
  for (const scenario of [null, { risk: 'critical', failures: {} }, scene('high', { missing: 1 }), scene('high', { search: -1 }), scene('high', { search: 4 }), scene('high', { search: 1.2 })]) {
    const run = simulateWorkflow(simple(), scenario);
    assert.equal(run.status, 'invalid'); assert.deepEqual(run.trace, []);
  }
  for (const decisions of [{ foreign: 'approve' }, { search: 'yes' }, []]) assert.equal(simulateWorkflow(simple(), scene(), decisions).status, 'invalid');
  const unsafe = simple(); unsafe.nodes[0].arguments.filter = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(simulateWorkflow(unsafe).status, 'invalid');
  assert.equal({}.polluted, undefined);
});

test('recomputation is deterministic, isolated and does not mutate workflows, scenarios or decisions', () => {
  const w = getTemplate('feedback'), scenario = scene('low', { collect: 1 }), decisions = { send: 'approve' };
  const before = clone({ w, scenario, decisions });
  const first = simulateWorkflow(w, scenario, decisions), second = simulateWorkflow(w, scenario, decisions);
  assert.deepEqual({ ...first, elapsed_ms: 0 }, { ...second, elapsed_ms: 0 });
  assert.deepEqual({ w, scenario, decisions }, before);
  row(first, 'collect').output.items[0].text = 'changed'; first.scenario.risk = 'high';
  assert.deepEqual({ w, scenario, decisions }, before);
  assert.notEqual(row(second, 'collect').output.items[0].text, 'changed');
});

test('a valid prototype-named node still requires its own explicit approval and failure configuration', () => {
  const w = simple();
  w.nodes[0] = { ...w.nodes[0], id: 'constructor', tool: 'admin.notify', arguments: { message: '虚构通知' } };
  const waiting = simulateWorkflow(w);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(row(waiting, 'constructor').attempts, 0);
  assert.equal(row(waiting, 'constructor').decision_key, 'constructor');
  const approved = simulateWorkflow(w, scene(), { constructor: 'approve' });
  assert.equal(approved.status, 'completed');
  assert.equal(row(approved, 'constructor').output.sent, false);
  const failed = simulateWorkflow(w, scene('high', { constructor: 'always' }), { constructor: 'approve' });
  assert.equal(failed.status, 'failed');
  assert.equal(row(failed, 'constructor').attempts, 1);
});
