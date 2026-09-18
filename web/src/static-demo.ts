import type { CompileResult, Node, Simulation, Workflow } from "./api";

const node = (id:string,tool:string,arguments_:Record<string,unknown>,depends_on:string[]=[],requires_approval=false,when?:string):Node => ({id,tool,arguments:arguments_,depends_on,requires_approval,when});

function compileWorkflow(instruction:string):Workflow {
  const nodes:Node[]=[];
  if(instruction.includes("反馈")) nodes.push(node("collect","feedback.search",{date_range:"last_week",product:"客户反馈"}));
  else nodes.push(node("search","knowledge.search",{query:instruction,top_k:8}));
  let source=nodes[0].id;
  if(instruction.includes("分类")||instruction.includes("模块")){nodes.push(node("classify","text.classify",{labels:["体验","性能","功能"],input_from:source},[source]));source="classify";}
  if(instruction.includes("风险")){nodes.push(node("risk","risk.classify",{input_from:source,threshold:"high"},[source]));source="risk";}
  let approval:string|undefined;
  if(instruction.includes("确认")||instruction.includes("审批")){nodes.push(node("approve","human.approval",{input_from:source,assignee:"owner"},[source],true,instruction.includes("风险")?"risk == high":undefined));approval="approve";}
  if(instruction.includes("周报")||instruction.includes("报告")){nodes.push(node("report","report.generate",{input_from:source,template:"weekly"},approval?[source,approval]:[source]));source="report";}
  if(instruction.includes("发")||instruction.includes("通知")){const email=instruction.includes("邮件");nodes.push(node("send",email?"email.send":"message.send",email?{input_from:source,recipient:"team@example.com"}:{input_from:source,channel:"product-team"},[source],true));}
  return {schema_version:"1.0",name:instruction.includes("反馈")?"feedback_workflow":"generated_workflow",description:instruction,trigger:{type:instruction.includes("每周")?"cron":"manual"},nodes};
}

const delay=<T,>(value:T)=>new Promise<T>((resolve)=>window.setTimeout(()=>resolve(value),260));

export const staticApi={
  compile:(instruction:string)=>{const workflow=compileWorkflow(instruction);return delay<CompileResult>({request_id:"static-demo-request",elapsed_ms:6.4,compiler:"heuristic-static-v1",workflow,validation:{valid:true,schema_valid:true,dag_valid:true,issues:[],topological_order:workflow.nodes.map((x)=>x.id)},repair_log:[]});},
  simulate:(workflow:Workflow,_approve:boolean)=>delay<Simulation>({status:"completed",elapsed_ms:4.1,trace:workflow.nodes.map((x)=>({node_id:x.id,tool:x.tool,status:"succeeded",message:"沙箱模拟完成；未执行真实外部操作"}))}),
};
