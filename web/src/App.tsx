import { useState } from "react";
import { ArrowRight, Braces, Check, CircleDot, Code2, Cpu, GitFork, Play, ShieldCheck, Sparkles } from "lucide-react";
import { api, CompileResult, Simulation } from "./api";

const examples=[
  "每周一汇总上周客户反馈，按产品模块分类；高风险问题先让负责人确认，再生成周报并发到产品群。失败时重试两次。",
  "搜索产品知识并生成报告，确认后通过邮件发送。",
  "检索用户反馈，识别风险并通知管理员。",
];

export function App(){
  const [instruction,setInstruction]=useState(examples[0]);
  const [result,setResult]=useState<CompileResult|null>(null);
  const [simulation,setSimulation]=useState<Simulation|null>(null);
  const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const compile=async()=>{setBusy(true);setError("");setSimulation(null);try{setResult(await api.compile(instruction));}catch(e){setError(e instanceof Error?e.message:"未知错误");}finally{setBusy(false);}};
  const simulate=async()=>{if(!result?.workflow)return;setBusy(true);try{setSimulation(await api.simulate(result.workflow,true));}catch(e){setError(e instanceof Error?e.message:"未知错误");}finally{setBusy(false);}};
  return <div className="app">
    <header><a className="brand" href="#top"><span>F/</span>FlowSpec</a><div className="status"><i/>SANDBOX ONLY</div><a href="https://github.com/daizhouchen/flowspec-sft"><Code2 size={16}/> Repository</a></header>
    <main id="top">
      <section className="intro"><div><p className="kicker">STRUCTURED AGENT SYSTEMS · 02</p><h1>把一句任务，<br/>编译成可检查的工作流。</h1><p className="lede">自然语言不是执行计划。FlowSpec 将业务描述转换为受 Schema 约束的 DAG，在运行前检查工具、参数、依赖、审批与失败路径。</p></div><div className="protocol"><p>WORKFLOWSPEC / V1.0</p><pre>{`instruction\n   ↓ compile\nJSON DAG\n   ↓ validate\nsandbox trace`}</pre><span><ShieldCheck size={15}/> 无真实外部写操作</span></div></section>
      <section className="lab">
        <div className="input-pane"><div className="pane-title"><span>01</span><div><p>INPUT</p><h2>描述任务</h2></div></div><textarea value={instruction} maxLength={600} onChange={e=>setInstruction(e.target.value)}/><div className="input-meta"><span>{instruction.length}/600</span><button onClick={compile} disabled={busy||instruction.length<4}><Sparkles size={16}/>{busy?"编译中":"编译工作流"}</button></div><div className="examples">{examples.map((x,i)=><button key={x} onClick={()=>setInstruction(x)}>示例 {i+1}<ArrowRight size={12}/></button>)}</div>
          <div className="guardrails"><div><Braces size={16}/><span>JSON Schema</span></div><div><GitFork size={16}/><span>DAG 检查</span></div><div><CircleDot size={16}/><span>单次修复</span></div></div>
        </div>
        <div className="output-pane"><div className="pane-title"><span>02</span><div><p>OUTPUT</p><h2>工作流图</h2></div>{result&&<b className={result.validation.valid?"ok":"bad"}>{result.validation.valid?"VALID":"INVALID"}</b>}</div>
          {!result&&<div className="empty"><Cpu size={30}/><p>等待编译</p><span>生成结果会在这里展示节点、依赖和校验状态。</span></div>}
          {result?.workflow&&<><div className="flow">{result.workflow.nodes.map((node,i)=><div className="flow-row" key={node.id}>{i>0&&<div className="connector"/>}<article><span>{String(i+1).padStart(2,"0")}</span><div><small>{node.id}</small><h3>{node.tool}</h3><p>{node.depends_on.length?`依赖 ${node.depends_on.join(", ")}`:"入口节点"}{node.when?` · ${node.when}`:""}</p></div>{node.requires_approval&&<em>APPROVAL</em>}</article></div>)}</div>
            <div className="validation"><div><Check size={15}/><span>Schema {result.validation.schema_valid?"通过":"失败"}</span></div><div><Check size={15}/><span>DAG {result.validation.dag_valid?"通过":"失败"}</span></div><div><span>{result.elapsed_ms} ms · {result.compiler}</span></div></div>
            <button className="simulate" onClick={simulate} disabled={busy}><Play size={15}/>在沙箱中模拟</button></>}
          {simulation&&<div className="trace"><div><strong>执行轨迹</strong><span>{simulation.status} · {simulation.elapsed_ms} ms</span></div>{simulation.trace.map(step=><p key={step.node_id}><i/><b>{step.node_id}</b><span>{step.message}</span></p>)}</div>}
          {error&&<p className="error">{error}</p>}
        </div>
      </section>
      <section className="principles"><p className="kicker">DESIGN PRINCIPLES</p><div><article><span>01</span><h3>先校验，再执行</h3><p>模型输出必须通过结构、依赖和工具参数检查。</p></article><article><span>02</span><h3>模型与规则协同</h3><p>格式问题由确定性规则修复，语义错误只反馈一次。</p></article><article><span>03</span><h3>结果可测量</h3><p>用合法率、参数 F1 和沙箱通过率评价，而不是只看 Loss。</p></article></div></section>
    </main><footer><span>FlowSpec · Natural language → validated DAG</span><span>Dai Zhouchen · 2026</span></footer>
  </div>;
}
