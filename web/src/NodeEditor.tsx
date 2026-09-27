import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { TOOL_CATALOG, validateWorkflow, type WorkflowNode, type WorkflowSpec } from './workflow-domain';
import { CATEGORY, ErrorMessage, Modal } from './ui';

export function newNode(workflow: WorkflowSpec, toolName = 'text.summarize'): WorkflowNode {
  let count = workflow.nodes.length + 1; while (workflow.nodes.some(n => n.id === `step_${count}`)) count++;
  const source = workflow.nodes.at(-1)?.id;
  const tool = TOOL_CATALOG.find(t => t.name === toolName)!;
  return { id: `step_${count}`, tool: toolName, arguments: tool.parameters.input_from && source ? { input_from: source } : {}, depends_on: source ? [source] : [], requires_approval: tool.risk === 'notify' || tool.risk === 'approval', retry: { max_attempts: 0, backoff_seconds: 0 }, when: null, on_failure: null };
}

export function NodeEditor({ workflow, node, adding, save, remove, close }: { workflow: WorkflowSpec; node: WorkflowNode; adding?: boolean; save: (node: WorkflowNode) => void; remove: () => void; close: () => void }) {
  const [draft, setDraft] = useState<WorkflowNode>(structuredClone(node));
  const [raw, setRaw] = useState<Record<string, string>>(Object.fromEntries(Object.entries(node.arguments).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
  const [error, setError] = useState('');
  const [failureRaw, setFailureRaw] = useState(JSON.stringify(node.on_failure?.arguments || {}, null, 2));
  const [deleting, setDeleting] = useState(false);
  const tool = TOOL_CATALOG.find(t => t.name === draft.tool);
  const references = workflow.nodes.filter(n => n.id !== node.id && (n.depends_on.includes(node.id) || n.arguments.input_from === node.id || n.on_failure?.arguments.input_from === node.id));
  function commit() {
    try {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!value.trim()) continue;
        const type = tool?.parameters[key]?.type;
        if (type === 'array' || type === 'object' || type === 'boolean') { try { args[key] = JSON.parse(value); } catch { throw new Error(`${tool?.parameters[key]?.description || key} 需要有效的 ${type === 'array' ? 'JSON 数组，如 ["体验","性能"]' : 'JSON 值'}。`); } }
        else if (type === 'integer') { if (!Number.isSafeInteger(Number(value))) throw new Error(`${tool?.parameters[key]?.description || key} 需要整数。`); args[key] = Number(value); }
        else args[key] = value;
      }
      const failureArguments = draft.on_failure ? JSON.parse(failureRaw) : null; if (draft.on_failure && (!failureArguments || Array.isArray(failureArguments) || typeof failureArguments !== 'object')) throw new Error('失败处理参数必须是 JSON 对象。'); save({ ...draft, arguments: args, on_failure: draft.on_failure ? { ...draft.on_failure, arguments: failureArguments } : null });
    } catch (e) { setError(e instanceof Error ? e.message : '节点未保存'); }
  }
  return <Modal title={adding ? '添加一个流程步骤' : `设置步骤 · ${node.id}`} close={close} wide>
    <p className="muted">参数与依赖都可以修改。保存后会重新检查流程；原有试跑保留为历史记录。</p>
    <label className="field">步骤工具<select value={draft.tool} onChange={e => { const next = newNode(workflow, e.target.value); setDraft({ ...draft, tool: next.tool, arguments: next.arguments, requires_approval: next.requires_approval }); setRaw(Object.fromEntries(Object.entries(next.arguments).map(([k, v]) => [k, String(v)]))); }}>
      {!tool && <option value={draft.tool}>{draft.tool}（未知工具，请重新选择）</option>}
      {Object.entries(CATEGORY).map(([category, label]) => <optgroup key={category} label={label}>{TOOL_CATALOG.filter(t => t.category === category).map(t => <option key={t.name} value={t.name}>{t.description} · {t.name}</option>)}</optgroup>)}
    </select><small>更换工具会重置本节点参数，保存前可取消。</small></label>
    <div className="form-grid">{tool && Object.entries(tool.parameters).map(([name, param]) => <label className="field" key={`${draft.tool}-${name}`}>{param.description}{param.required ? ' *' : '（选填）'}<small className="code-label">{name}</small>{name === 'input_from' ? <select value={raw[name] || ''} onChange={e => setRaw({ ...raw, [name]: e.target.value })}><option value="">选择输入数据来源</option>{workflow.nodes.filter(n => n.id !== node.id).map(n => <option value={n.id} key={n.id}>{n.id} · {TOOL_CATALOG.find(t => t.name === n.tool)?.description || n.tool}</option>)}</select> : param.type === 'object' || param.type === 'array' ? <textarea rows={3} value={raw[name] || ''} placeholder={param.type === 'array' ? '["体验", "性能", "功能"]' : '{"status":"open"}'} maxLength={4000} onChange={e => setRaw({ ...raw, [name]: e.target.value })}/> : <input value={raw[name] || ''} maxLength={2000} inputMode={param.type === 'integer' ? 'numeric' : undefined} onChange={e => setRaw({ ...raw, [name]: e.target.value })}/>}</label>)}</div>
    {tool && Object.keys(raw).filter(k => !tool.parameters[k]).length > 0 && <div className="notice"><p>原节点含不受支持的参数，请确认并移除：</p>{Object.keys(raw).filter(k => !tool.parameters[k]).map(k => <button className="secondary" key={k} onClick={() => { const next = { ...raw }; delete next[k]; setRaw(next); }}>移除 {k}</button>)}</div>}
    <fieldset><legend>先完成哪些步骤</legend><p className="muted">执行依赖控制先后顺序；输入数据来源还必须位于上游。</p><div className="dependency-options">{workflow.nodes.filter(n => n.id !== node.id).map(n => <label key={n.id}><input type="checkbox" checked={draft.depends_on.includes(n.id)} onChange={e => setDraft({ ...draft, depends_on: e.target.checked ? [...draft.depends_on, n.id] : draft.depends_on.filter(id => id !== n.id) })}/><span>{n.id}<small>{TOOL_CATALOG.find(t => t.name === n.tool)?.description || n.tool}</small></span></label>)}{!workflow.nodes.some(n => n.id !== node.id) && <p className="muted">这是第一个步骤，无需上游。</p>}{draft.depends_on.filter(id => id === node.id || !workflow.nodes.some(n => n.id === id)).map(id => <button className="secondary" key={id} onClick={() => setDraft({ ...draft, depends_on: draft.depends_on.filter(x => x !== id) })}>移除无效依赖 {id}</button>)}</div></fieldset>
    <div className="form-grid"><label className="field">执行条件<select value={draft.when || ''} onChange={e => setDraft({ ...draft, when: e.target.value || null })}><option value="">始终执行</option>{['risk == high', 'risk == medium', 'risk == low', 'risk != high', 'risk != medium', 'risk != low'].map(v => <option key={v}>{v}</option>)}{draft.when && !/^risk (==|!=) (high|medium|low)$/.test(draft.when) && <option>{draft.when}</option>}</select><small>风险条件需要上游“识别风险等级”步骤。</small></label><label className="field">失败后额外重试<select value={draft.retry?.max_attempts || 0} onChange={e => setDraft({ ...draft, retry: { max_attempts: Number(e.target.value), backoff_seconds: draft.retry?.backoff_seconds || 0 } })}>{[0,1,2,3].map(n => <option value={n} key={n}>{n} 次</option>)}</select><small>0 次表示只尝试一次。</small></label><label className="field">重试间隔（秒）<input type="number" min={0} max={300} value={draft.retry?.backoff_seconds || 0} onChange={e => setDraft({ ...draft, retry: { max_attempts: draft.retry?.max_attempts || 0, backoff_seconds: Number(e.target.value) } })}/><small>记录策略；浏览器试跑不会实际等待。</small></label></div>
    <label className="check"><input type="checkbox" checked={draft.requires_approval} onChange={e => setDraft({ ...draft, requires_approval: e.target.checked })}/>执行前请求确认</label><p className="muted">审核和通知工具在沙箱中始终停下来等待你确认。</p>
    <details className="advanced"><summary>失败处理</summary><label className="field">重试耗尽后<select value={draft.on_failure?.tool || ''} onChange={e => { const args = e.target.value === 'admin.notify' ? { message: '流程步骤失败，请负责人检查。' } : {}; setDraft({ ...draft, on_failure: e.target.value ? { tool: e.target.value, arguments: args } : null }); setFailureRaw(JSON.stringify(args, null, 2)); }}><option value="">只记录失败，阻止依赖步骤</option>{TOOL_CATALOG.map(t => <option value={t.name} key={t.name}>{t.description} · {t.name}</option>)}</select><small>通知与审核处理器仍需人工确认；成功处理失败不代表主步骤成功。</small></label>{draft.on_failure && <label className="field">失败处理参数 JSON<textarea rows={4} value={failureRaw} maxLength={4000} onChange={e => setFailureRaw(e.target.value)}/><small>必填参数：{Object.entries(TOOL_CATALOG.find(t => t.name === draft.on_failure?.tool)?.parameters || {}).filter(([, p]) => p.required).map(([k, p]) => `${k}（${p.description}）`).join('、') || '无'}</small></label>}</details>
    <ErrorMessage message={error}/>{deleting && <div className="danger-panel"><h3>删除这一步？</h3>{references.length ? <p>请先在 {references.map(n => n.id).join('、')} 中移除对此步骤的依赖或输入引用，再删除。</p> : <><p>当前方案会移除该步骤，历史试跑仍保留原快照。</p><button className="danger" onClick={remove}>确认删除步骤</button></>}<button className="secondary" onClick={() => setDeleting(false)}>保留步骤</button></div>}
    <div className="modal-actions">{!adding && <button className="quiet" disabled={workflow.nodes.length <= 1} onClick={() => setDeleting(true)}><Trash2/>删除步骤</button>}<button className="secondary" onClick={close}>取消</button><button className="primary" onClick={commit}>{adding ? <Plus/> : <Check/>}{adding ? '添加到流程' : '保存节点设置'}</button></div>
  </Modal>;
}
