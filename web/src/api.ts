export const isPublicSandbox = import.meta.env.VITE_STATIC_DEMO === 'true';
export async function compileWithBackend(instruction: string, signal?: AbortSignal): Promise<{ workflow: unknown; compiler: string; repair_log: string[] }> {
  const response = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, repair_once: true }), signal });
  if (!response.ok) throw new Error(`编译服务返回 ${response.status}。已有方案已保留，可以使用规则草案或手动编排。`);
  const data = await response.json();
  if (!data.workflow || !data.validation?.valid) throw new Error(data.validation?.issues?.map((i: { message: string }) => i.message).join('；') || '后端未返回有效方案，请修改需求或手动编排。');
  return { workflow: data.workflow, compiler: data.compiler || 'configured-backend', repair_log: Array.isArray(data.repair_log) ? data.repair_log : [] };
}
