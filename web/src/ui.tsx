import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; const dialog = ref.current!; if (!dialog.open) dialog.showModal(); return () => { dialog.close(); requestAnimationFrame(() => { if (returnTo.current?.isConnected) returnTo.current.focus(); }); }; }, []);
  return <dialog ref={ref} className={`fs-modal ${wide ? 'wide' : ''}`} aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); closeRef.current(); }}><header><div><span className="eyebrow">FLOWSPEC / WORKSPACE</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={close} aria-label="关闭对话框"><X/></button></header><div className="modal-content">{children}</div></dialog>;
}
export function downloadFile(name: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, '-'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const date = (n: number) => new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const STATUS: Record<string, string> = { completed: '试跑完成', waiting_approval: '等待确认', failed: '试跑失败', invalid: '检查未通过', succeeded: '模拟成功', skipped: '条件未命中', blocked: '上游未完成', rejected: '已拒绝', pending: '等待上游' };
export const CATEGORY: Record<string, string> = { retrieval: '获取资料', classification: '分类判断', transformation: '处理内容', reporting: '形成结果', approval: '人工审核', notification: '发送通知' };
export function ErrorMessage({ message }: { message: string }) { return message ? <p className="error-message" role="alert">{message}</p> : null; }
