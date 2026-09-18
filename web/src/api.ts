export type Node = { id:string; tool:string; arguments:Record<string,unknown>; depends_on:string[]; when?:string; requires_approval:boolean };
export type Workflow = { schema_version:string; name:string; description:string; trigger:{type:string}; nodes:Node[] };
export type Issue = { code:string; level:string; message:string; node_id?:string };
export type CompileResult = { request_id:string; elapsed_ms:number; compiler:string; workflow:Workflow|null; validation:{valid:boolean; schema_valid:boolean; dag_valid:boolean; issues:Issue[]; topological_order:string[]}; repair_log:string[] };
export type Simulation = { status:string; elapsed_ms:number; trace:{node_id:string; tool:string; status:string; message:string}[] };
async function request<T>(path:string, init?:RequestInit):Promise<T>{ const response=await fetch(path,init); if(!response.ok) throw new Error(`请求失败：${response.status}`); return response.json(); }
export const api={
  compile:(instruction:string)=>import.meta.env.VITE_STATIC_DEMO==="true"?staticApi.compile(instruction):request<CompileResult>("/api/compile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({instruction,repair_once:true})}),
  simulate:(workflow:Workflow,approve_human_steps:boolean)=>import.meta.env.VITE_STATIC_DEMO==="true"?staticApi.simulate(workflow,approve_human_steps):request<Simulation>("/api/simulate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workflow,approve_human_steps})}),
};
import { staticApi } from "./static-demo";
