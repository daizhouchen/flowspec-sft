import { TOOL_CATALOG, type WorkflowSpec } from './workflow-domain';
import { GitFork, ShieldCheck } from 'lucide-react';
export function WorkflowGraph({ workflow, selected, select, badIds }: { workflow: WorkflowSpec; selected: string; select: (id: string) => void; badIds: Set<string> }) {
  const nodes = workflow.nodes;
  const depths = new Map<string, number>();
  for (let round = 0; round < nodes.length; round++) for (const n of nodes) if (!depths.has(n.id) && n.depends_on.every(id => depths.has(id))) depths.set(n.id, n.depends_on.length ? Math.max(...n.depends_on.map(id => depths.get(id)!)) + 1 : 0);
  const counts = new Map<number, number>();
  const positions = nodes.map(n => { const d = depths.get(n.id) ?? 0; const r = counts.get(d) || 0; counts.set(d, r + 1); return { id: n.id, x: 24 + d * 238, y: 32 + r * 142 }; });
  const width = Math.max(560, ...positions.map(p => p.x + 234)); const height = Math.max(262, ...positions.map(p => p.y + 144));
  return <><div className="graph-caption"><span><GitFork/>依赖关系图</span><small>点击节点修改 · 连线表示执行依赖</small></div><div className="graph-scroll" tabIndex={0} aria-label="工作流依赖画布，可横向滚动"><div className="graph-canvas" style={{ width, height }}>
    <svg width={width} height={height} aria-hidden="true"><defs><marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="#80979a"/></marker></defs>{nodes.flatMap(n => n.depends_on.map(id => { const a = positions.find(p => p.id === id), b = positions.find(p => p.id === n.id); if (!a || !b) return null; const mx = (a.x + 206 + b.x) / 2; return <path key={`${id}-${n.id}`} d={`M${a.x + 206},${a.y + 49} C${mx},${a.y + 49} ${mx},${b.y + 49} ${b.x - 3},${b.y + 49}`} markerEnd="url(#arrowhead)" fill="none" stroke="#80979a" strokeWidth="1.5"/>; }))}</svg>
    {nodes.map((n, i) => { const p = positions[i]; const tool = TOOL_CATALOG.find(t => t.name === n.tool); return <button key={n.id} className={`graph-node ${selected === n.id ? 'selected' : ''} ${badIds.has(n.id) ? 'has-error' : ''}`} style={{ left: p.x, top: p.y }} onClick={() => select(n.id)} aria-pressed={selected === n.id}><span className="node-index">{String(i + 1).padStart(2, '0')} / {n.id}</span><strong>{tool?.description || n.tool}</strong><small>{n.when ? n.when : n.depends_on.length ? `${n.depends_on.length} 项依赖` : '流程入口'}{(n.requires_approval || tool?.risk === 'approval' || tool?.risk === 'notify') && <ShieldCheck size={13}/>}</small></button>; })}
  </div></div></>;
}
