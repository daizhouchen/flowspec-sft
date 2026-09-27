import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, simulateWorkflow } from '../src/workflow-domain.ts';
import { createPlan, updatePlan, clonePlan, startRun, decideRun, validateBackup, serializeBackup, exportHandoff, WORKSPACE_LIMITS } from '../src/workspace.ts';

const NOW = 1_780_000_000_000;
const scenario = () => ({ risk: 'high', failures: {} });
const workflow = () => ({ schema_version: '1.0', name: 'review_report', description: '收集后审核并发送', trigger: { type: 'manual' }, nodes: [
  { id: 'search', tool: 'knowledge.search', arguments: { query: '本周反馈' } },
  { id: 'approve', tool: 'human.approval', arguments: { input_from: 'search' }, depends_on: ['search'] },
  { id: 'send', tool: 'message.send', arguments: { input_from: 'search', channel: '产品群' }, depends_on: ['approve'] },
] });
const plan = () => createPlan(workflow(), { title: '周报方案', brief: '审核之后发送。', origin: 'test', notes: ['用户仍需核对接收群。'] }, NOW);
const running = () => startRun(plan(), scenario(), NOW + 1);
const simulation = value => {
  const run = value.runs.find(item => item.id === value.activeRunId);
  return simulateWorkflow(run.workflow, run.scenario, run.decisions);
};

test('plans canonicalize workflow shape but preserve semantically invalid drafts for later repair', () => {
  const original = workflow();
  const p = createPlan(original, { title: '  初稿  ' }, NOW);
  assert.equal(p.title, '初稿');
  assert.deepEqual(p.workflow, validateWorkflow(original).workflow);
  original.nodes[0].arguments.query = 'changed outside';
  assert.equal(p.workflow.nodes[0].arguments.query, '本周反馈');
  const defaulted = workflow(); defaulted.trigger = null; defaulted.nodes[0].retry = null;
  assert.deepEqual(createPlan(defaulted, { title: '规范化缺省值' }, NOW).workflow, validateWorkflow(defaulted).workflow);
  const draft = workflow(); draft.nodes[1].tool = 'unknown.review';
  const pending = createPlan(draft, { title: '待修复工具' }, NOW);
  assert.equal(validateWorkflow(pending.workflow).schema_valid, true);
  assert.equal(validateWorkflow(pending.workflow).valid, false);
  assert.deepEqual(validateBackup(serializeBackup(pending)), pending);
  assert.throws(() => startRun(pending, scenario(), NOW + 1));
  assert.throws(() => createPlan({ ...draft, nodes: [] }, { title: '空流程' }, NOW));
});

test('content edits advance revision and invalidate active runs while retaining independent history', () => {
  const p = running();
  const original = structuredClone(p);
  const titled = updatePlan(p, { title: '新标题' }, NOW + 2);
  assert.equal(titled.revision, p.revision);
  assert.equal(titled.activeRunId, p.activeRunId);
  const briefEdit = updatePlan(titled, { brief: '改为另一周范围。' }, NOW + 3);
  assert.equal(briefEdit.revision, p.revision + 1);
  assert.equal(briefEdit.activeRunId, null);
  const changedWorkflow = workflow(); changedWorkflow.nodes[0].arguments.query = '上月反馈';
  const edited = updatePlan(briefEdit, { workflow: changedWorkflow }, NOW + 4);
  assert.equal(edited.revision, p.revision + 2);
  assert.equal(edited.runs[0].workflow.nodes[0].arguments.query, '本周反馈');
  assert.deepEqual(p, original);
  assert.throws(() => decideRun(edited, 'approve', 'approve', NOW + 5));
  assert.deepEqual(validateBackup(serializeBackup(edited)), edited);
});

test('runs snapshot scenario and workflow, retain only ten records and enforce scenario bounds', () => {
  let p = plan();
  const input = scenario();
  p = startRun(p, input, NOW + 1);
  input.risk = 'low'; input.failures.search = 'always';
  assert.deepEqual(p.runs[0].scenario, scenario());
  for (let index = 2; index <= 12; index++) p = startRun(p, scenario(), NOW + index);
  assert.equal(p.runs.length, 10);
  assert.equal(p.activeRunId, p.runs[0].id);
  assert.equal(new Set(p.runs.map(run => run.id)).size, 10);
  assert.equal(p.runs.at(-1).startedAt, NOW + 3);
  assert.deepEqual(validateBackup(serializeBackup(p)), p);
  assert.throws(() => startRun(p, { risk: 'high', failures: { absent: 'always' } }, NOW + 13));
  assert.throws(() => startRun(p, { risk: 'high', failures: { search: 4 } }, NOW + 13));
});

test('approval is recorded only for reachable waiting steps in the active revision', () => {
  let p = running();
  assert.equal(simulation(p).status, 'waiting_approval');
  assert.throws(() => decideRun(p, 'send', 'approve', NOW + 2));
  assert.throws(() => decideRun(p, 'search', 'approve', NOW + 2));
  p = decideRun(p, 'approve', 'approve', NOW + 2);
  assert.equal(simulation(p).status, 'waiting_approval');
  assert.throws(() => decideRun(p, 'approve', 'reject', NOW + 3));
  p = decideRun(p, 'send', 'reject', NOW + 3);
  assert.notEqual(simulation(p).status, 'completed');
  assert.equal(simulation(p).nodes.find(node => node.node_id === 'send').status, 'rejected');
  assert.deepEqual(validateBackup(serializeBackup(p)), p);
});

test('duplicate plans clear history while complete backup restoration preserves resumable approvals', () => {
  let p = decideRun(running(), 'approve', 'approve', NOW + 2);
  const copied = clonePlan(p, NOW + 3);
  assert.notEqual(copied.id, p.id);
  assert.deepEqual(copied.runs, []);
  assert.equal(copied.activeRunId, null);
  assert.equal(copied.revision, 1);
  const restored = clonePlan(validateBackup(serializeBackup(p)), NOW + 3, true);
  assert.notEqual(restored.id, p.id);
  assert.equal(restored.activeRunId, p.activeRunId);
  assert.deepEqual(restored.runs, p.runs);
  assert.equal(simulation(restored).status, 'waiting_approval');
  const completed = decideRun(restored, 'send', 'approve', NOW + 4);
  assert.equal(simulation(completed).status, 'completed');
  assert.equal(simulation(p).status, 'waiting_approval');
  assert.deepEqual(validateBackup(serializeBackup(completed)), completed);
});

test('backup validation rejects unknown data, invalid history, forged decisions and inconsistent snapshots atomically', () => {
  const p = running();
  const changes = [
    draft => { draft.schemaVersion = 2; },
    draft => { draft.injected = true; },
    draft => { draft.workflow.nodes[0].extension = 'unknown semantics'; },
    draft => { draft.runs[0].output = 'fabricated output'; },
    draft => { draft.activeRunId = 'missing'; },
    draft => { draft.runs[0].id = draft.id; },
    draft => { draft.runs[0].revision = 2; },
    draft => { draft.runs[0].startedAt = draft.createdAt - 1; },
    draft => { draft.runs[0].scenario.failures.missing = 'always'; },
    draft => { draft.runs[0].scenario.risk = 'extreme'; },
    draft => { draft.runs[0].decisions.send = 'approve'; },
    draft => { draft.runs[0].decisions.approve = 'not-a-decision'; },
    draft => { draft.runs[0].workflow.nodes[0].arguments.query = 'different snapshot'; },
    draft => { draft.updatedAt = Date.now() + 3_600_000; },
    draft => { draft.runs = Array(11).fill(draft.runs[0]); },
  ];
  for (const change of changes) {
    const draft = structuredClone(p); change(draft);
    assert.throws(() => validateBackup(draft), change.toString());
  }
  for (const raw of [null, [], new Date(), 'not JSON', { ...p, notes: new Array(1) }, ' '.repeat(WORKSPACE_LIMITS.backupBytes + 1)])
    assert.throws(() => validateBackup(raw));
  const deep = structuredClone(p); let cursor = deep;
  for (let index = 0; index < 20; index++) { cursor.extra = {}; cursor = cursor.extra; }
  assert.throws(() => validateBackup(deep), /嵌套|结构/);
  const cycle = structuredClone(p); cycle.self = cycle;
  assert.throws(() => validateBackup(cycle), /循环/);
});

test('failure-handler decisions survive backup without approving the failed main node', () => {
  const source = workflow();
  source.nodes[0].on_failure = { tool: 'admin.notify', arguments: { message: '需要人工检查检索失败' } };
  let p = startRun(createPlan(source, { title: '失败分支' }, NOW), { risk: 'high', failures: { search: 'always' } }, NOW + 1);
  assert.equal(simulation(p).nodes.find(node => node.node_id === 'search').failure_handler.status, 'waiting_approval');
  p = decideRun(p, 'search:failure', 'approve', NOW + 2);
  assert.equal(p.runs[0].decisions['search:failure'], 'approve');
  assert.equal(simulation(p).nodes.find(node => node.node_id === 'search').status, 'failed');
  assert.deepEqual(validateBackup(serializeBackup(p)), p);
});

test('handoff uses the selected historical snapshot and recomputed trace, with explicit simulation limits', () => {
  const p = running();
  const revisedWorkflow = workflow(); revisedWorkflow.name = 'different_revision';
  const edited = updatePlan(p, { workflow: revisedWorkflow }, NOW + 2);
  const markdown = exportHandoff(edited, edited.runs[0]);
  assert.match(markdown, /没有执行真实外部操作/);
  assert.match(markdown, /方案版本：2/);
  assert.match(markdown, /快照版本：1/);
  assert.match(markdown, /waiting_approval/);
  assert.match(markdown, /"name": "review_report"/);
  assert.doesNotMatch(markdown, /"name": "different_revision"/);
  assert.throws(() => exportHandoff(p, { ...p.runs[0], id: 'other-run' }));
});

// A small asynchronous IndexedDB substitute exercises transaction commit/abort and tab revision conflicts.
function memoryIndexedDB() {
  let stored;
  let quota = false;
  const databases = [];
  return {
    get stored() { return stored; },
    set quota(value) { quota = value; },
    api: { open(name) {
      databases.push(name);
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true }, close() {},
          transaction(_store, mode) {
            let aborted = false; let pending;
            const tx = {
              abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
              objectStore() { return {
                get(key) {
                  assert.equal(key, 'flowspec-workspace/v1');
                  const result = {};
                  queueMicrotask(() => {
                    result.result = structuredClone(stored);
                    result.onsuccess?.();
                    queueMicrotask(() => {
                      if (aborted) return;
                      if (mode === 'readwrite' && pending !== undefined) stored = pending;
                      tx.oncomplete?.();
                    });
                  });
                  return result;
                },
                put(value, key) {
                  assert.equal(key, 'flowspec-workspace/v1');
                  if (quota) throw new Error('QuotaExceededError');
                  pending = structuredClone(value);
                  return {};
                },
              }; },
            };
            return tx;
          },
        };
        request.onsuccess?.();
      });
      return request;
    } },
    databases,
  };
}
let storeCounter = 0;
const freshStore = () => import(`../src/workspace-store.ts?test=${++storeCounter}`);

test('IndexedDB saves commit atomically and stale tabs cannot overwrite a newer library', async t => {
  const original = globalThis.indexedDB;
  const memory = memoryIndexedDB(); globalThis.indexedDB = memory.api;
  t.after(() => { globalThis.indexedDB = original; });
  const first = await freshStore(); const second = await freshStore();
  const p = plan(); const library = { schemaVersion: 1, plans: [p], selectedId: p.id };
  await assert.rejects(first.saveLibrary(library), /读取/);
  assert.deepEqual(await first.loadLibrary(), first.emptyLibrary());
  assert.deepEqual(await second.loadLibrary(), second.emptyLibrary());
  await first.saveLibrary(library);
  const durable = structuredClone(memory.stored);
  await assert.rejects(second.saveLibrary(second.emptyLibrary()), second.StorageConflictError);
  assert.deepEqual(memory.stored, durable);
  assert.deepEqual(await second.loadLibrary(), library);
  await second.saveLibrary({ ...library, selectedId: null });
  assert.equal(memory.stored.storageRevision, 2);
  assert.ok(memory.databases.every(name => name === 'flowspec-workspace'));
});

test('storage quota failures preserve old data, allow retry and snapshot caller state before queuing', async t => {
  const original = globalThis.indexedDB;
  const memory = memoryIndexedDB(); globalThis.indexedDB = memory.api;
  t.after(() => { globalThis.indexedDB = original; });
  const store = await freshStore(); await store.loadLibrary();
  const p = plan(); const library = { schemaVersion: 1, plans: [p], selectedId: p.id };
  memory.quota = true;
  await assert.rejects(store.saveLibrary(library));
  assert.equal(memory.stored, undefined);
  memory.quota = false;
  const saving = store.saveLibrary(library);
  library.plans[0].title = 'Mutated after save call';
  await saving;
  assert.equal(memory.stored.plans[0].title, '周报方案');
  assert.equal(memory.stored.storageRevision, 1);
  await assert.rejects(store.saveLibrary({ schemaVersion: 1, plans: Array(31).fill(p), selectedId: p.id }));
  await assert.rejects(store.saveLibrary({ schemaVersion: 1, plans: [p, p], selectedId: p.id }));
  assert.equal(memory.stored.storageRevision, 1);
});
