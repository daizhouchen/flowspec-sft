import { useRef, useState } from 'react';
import { ArrowRight, Check, FileUp, Sparkles } from 'lucide-react';
import { compileInstruction, validateWorkflow, type WorkflowSpec } from './workflow-domain';
import { compileWithBackend, isPublicSandbox } from './api';
import { clonePlan, createPlan, validateBackup, type Plan } from './workspace';
import { ErrorMessage, Modal } from './ui';

type Proposal = { workflow: WorkflowSpec; recognition: string[]; assumptions: string[]; unhandled: string[]; source: string };
export function CompileDialog({ initial = '', replacing = false, close, commit }: { initial?: string; replacing?: boolean; close: () => void; commit: (p: Proposal, instruction: string) => void }) {
  const [text, setText] = useState(initial); const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [ack, setAck] = useState(false); const [mode, setMode] = useState('rules');
  const token = useRef(0); const request = useRef<AbortController | null>(null);
  function invalidate() { token.current++; request.current?.abort(); setBusy(false); setProposal(null); setError(''); setAck(false); }
  function dismiss() { invalidate(); close(); }
  async function generate() {
    const generation = ++token.current; const input = text.trim(); setError(''); setProposal(null); setAck(false); setBusy(true);
    try {
      if (mode === 'backend') {
        const controller = new AbortController(); request.current = controller;
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
          const result = await compileWithBackend(input, controller.signal); if (generation !== token.current) return;
          const checked = validateWorkflow(result.workflow); if (!checked.workflow || !checked.schema_valid) throw new Error('后端方案结构未能读取，请检查服务返回。');
          setProposal({ workflow: checked.workflow, source: result.compiler, recognition: ['已取得本地配置后端的编译结果'], assumptions: ['后端输出仍需检查业务含义与参数。', ...result.repair_log], unhandled: checked.issues.filter(i => i.level === 'error').map(i => i.message) });
        } finally { clearTimeout(timeout); }
      } else {
        const result = compileInstruction(input); if (generation !== token.current) return;
        if (!result.workflow) throw new Error(result.unhandled.join('；') || '未能识别受支持的流程，请选择模板或手动添加步骤。');
        setProposal({ ...result, workflow: result.workflow });
      }
    } catch (e) { if (generation === token.current) setError(e instanceof Error && e.name === 'AbortError' ? '编译请求已取消或超时。可重试，已有方案保持不变。' : e instanceof Error ? e.message : '草案未生成'); }
    finally { if (generation === token.current) setBusy(false); }
  }
  return <Modal title={replacing ? '根据新需求重新起草' : '把业务需求整理成草案'} close={dismiss} wide>
    <div className="notice"><strong>有限规则起草，结果由你检查。</strong><p>可识别反馈、知识检索、分类、摘要、报告、审批、通知等组合。未支持的要求会单列；也可以直接选模板或手动编排。</p></div>
    {!isPublicSandbox && <label className="field">起草方式<select value={mode} onChange={e => { invalidate(); setMode(e.target.value); }}><option value="rules">浏览器规则草案</option><option value="backend">本地配置的编译后端</option></select><small>后端使用你的本地配置；不会把规则草案标为模型生成。</small></label>}
    <label className="field">业务需求<textarea rows={5} maxLength={600} value={text} placeholder="例如：汇总上周客户反馈，按模块分类，识别高风险问题后请负责人确认，再生成周报。" onChange={e => { invalidate(); setText(e.target.value); }}/><small>{text.length} / 600</small></label>
    <button className="primary" disabled={busy || text.trim().length < 4} onClick={() => void generate()}><Sparkles/>{busy ? '正在取得草案…' : '生成可检查的草案'}</button>
    <ErrorMessage message={error}/>
    {proposal && <section className="proposal"><h3>{proposal.workflow.nodes.length} 个步骤，先确认这些理解</h3><ol>{proposal.recognition.map((s, i) => <li key={i}>{s}</li>)}</ol><h4>采用的默认设置</h4><ul>{proposal.assumptions.map((s, i) => <li key={i}>{s}</li>)}</ul>{!!proposal.unhandled.length && <div className="warning"><h4>这些要求仍需你处理</h4><ul>{proposal.unhandled.map((s, i) => <li key={i}>{s}</li>)}</ul><label className="check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>我会在编排中补充或调整这些要求</label></div>}<p className="muted">生成来源：{proposal.source}。{replacing ? '采用后替换当前流程，之前的试跑保留为历史快照。' : '采用后创建一份本机方案，参数和步骤都可继续修改。'}</p></section>}
    <div className="modal-actions"><button className="secondary" onClick={dismiss}>取消</button><button className="primary" disabled={!proposal || (!!proposal.unhandled.length && !ack)} onClick={() => { if (proposal) try { commit(proposal, text.trim()); } catch (e) { setError(e instanceof Error ? e.message : '方案未创建'); } }}>{replacing ? '采用并替换当前流程' : '采用草案'}<ArrowRight/></button></div>
  </Modal>;
}

export function ImportDialog({ close, commit }: { close: () => void; commit: (plan: Plan) => void }) {
  const [text, setText] = useState(''); const [title, setTitle] = useState('导入的工作流'); const [candidate, setCandidate] = useState<Plan | null>(null); const [backup, setBackup] = useState(false); const [error, setError] = useState('');
  const request = useRef(0);
  function preview(raw: string) {
    setCandidate(null); setError('');
    try {
      if (raw.length > 2_000_000) throw new Error('文件超过 200 万字符，请减少历史记录后再导入。');
      const parsed = JSON.parse(raw);
      if (parsed.format) { const plan = validateBackup(parsed); setCandidate(plan); setTitle(plan.title); setBackup(true); }
      else { const checked = validateWorkflow(parsed); if (!checked.workflow || !checked.schema_valid) throw new Error(checked.issues.map(i => i.message).join('；')); setCandidate(createPlan(checked.workflow, { title: '导入的工作流', origin: 'import', notes: ['从 WorkflowSpec JSON 导入，业务参数需要核对。'] })); setBackup(false); }
    } catch (e) { setError(e instanceof SyntaxError ? 'JSON 格式有误，请检查引号、逗号与括号。' : e instanceof Error ? e.message : '无法读取方案'); }
  }
  async function read(file?: File) {
    const token = ++request.current; setCandidate(null); setError(''); if (!file) return;
    if (file.size > 6_000_000) { setError('文件超过 6 MB，未读取。'); return; }
    try { const raw = await file.text(); if (token !== request.current) return; setText(raw); preview(raw); } catch { if (token === request.current) setError('文件读取失败，可重选或粘贴 JSON。'); }
  }
  return <Modal title="导入工作流或恢复完整备份" close={close} wide>
    <p>WorkflowSpec JSON 用于交换流程；完整备份还包含试跑快照和等待确认的进度。导入会创建独立方案。</p>
    <label className="field file-field"><FileUp/>选择 JSON 文件<input type="file" accept=".json,application/json" onChange={e => void read(e.target.files?.[0])}/></label>
    <details className="advanced"><summary>或粘贴、修正 JSON</summary><label className="field">方案 JSON<textarea rows={9} value={text} maxLength={2_000_000} onChange={e => { request.current++; setText(e.target.value); setCandidate(null); setError(''); }}/></label><button className="secondary" onClick={() => preview(text)}>检查导入内容</button></details>
    {candidate && <><label className="field">导入后的方案名称<input value={title} maxLength={80} onChange={e => setTitle(e.target.value)}/></label><div className="notice"><strong>{backup ? '完整备份可恢复' : '流程结构可读取'}</strong><p>{candidate.workflow.nodes.length} 个步骤 · {candidate.runs.length} 条试跑记录</p><p>{validateWorkflow(candidate.workflow).valid ? '当前流程通过规则检查，仍需确认参数含义。' : '当前流程有待修正问题，导入后可在检查页逐项处理。'}</p></div></>}
    <ErrorMessage message={error}/><div className="modal-actions"><button className="secondary" onClick={close}>取消</button><button className="primary" disabled={!candidate || !title.trim()} onClick={() => { try { if (candidate) commit({ ...clonePlan(candidate, Date.now(), true), title: title.trim() }); } catch (e) { setError(e instanceof Error ? e.message : '导入未完成'); } }}><Check/>{backup ? '恢复为独立方案' : '导入为新方案'}</button></div>
  </Modal>;
}
