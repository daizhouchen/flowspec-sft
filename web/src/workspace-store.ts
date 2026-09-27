import { validateBackup, WORKSPACE_LIMITS, type Plan } from './workspace.ts';

export type Library = { schemaVersion: 1; plans: Plan[]; selectedId: string | null };
const DB_NAME = 'flowspec-workspace';
const STORE = 'workspace';
const KEY = 'flowspec-workspace/v1';
let expectedRevision: number | null = null;
let queue: Promise<void> = Promise.resolve();
export const emptyLibrary = (): Library => ({ schemaVersion: 1, plans: [], selectedId: null });

export class StorageConflictError extends Error {
  readonly code = 'STORAGE_CONFLICT';
  constructor() {
    super('另一个标签页已更新本机方案。当前修改尚未保存；请先导出备份，再重新载入，避免覆盖其他页面的修改。');
    this.name = 'StorageConflictError';
  }
}
function storageRevision(value: unknown): number {
  if (value === undefined) return 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机方案格式异常，未覆盖原数据。');
  const revision = (value as Record<string, unknown>).storageRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    throw new Error('本机记录的保存版本异常，未覆盖原数据。');
  return revision;
}
function validateLibrary(raw: unknown, stored = false): Library {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机方案库格式无效。');
  const value = raw as Record<string, unknown>;
  const allowed = ['schemaVersion', 'plans', 'selectedId', ...(stored ? ['storageRevision'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('本机方案库包含不受支持的字段，未覆盖原数据。');
  if (value.schemaVersion !== 1 || !Array.isArray(value.plans) || value.plans.length > WORKSPACE_LIMITS.plans)
    throw new Error('本机方案库版本无效或超过 30 个方案上限。');
  const plans = value.plans.map(plan => validateBackup(plan));
  if (new Set(plans.map(plan => plan.id)).size !== plans.length) throw new Error('本机存在重复方案编号。');
  if (value.selectedId !== null && (typeof value.selectedId !== 'string' || !plans.some(plan => plan.id === value.selectedId)))
    throw new Error('所选方案不存在，未覆盖原数据。');
  return { schemaVersion: 1, plans, selectedId: value.selectedId as string | null };
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器无法使用本机存储。当前修改可导出备份。')); return; }
    let settled = false;
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, 1); }
    catch { reject(new Error('浏览器拒绝打开本机存储，请检查隐私或站点存储设置。')); return; }
    const fail = (message: string) => { if (!settled) { settled = true; reject(new Error(message)); } };
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail('浏览器未能打开本机方案存储，原有记录未被覆盖。');
    request.onblocked = () => fail('另一个页面阻止了存储打开，请关闭旧页面后重试。');
  });
}
export async function loadLibrary(): Promise<Library> {
  expectedRevision = null;
  const db = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      let result: unknown;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('读取本机方案失败，原有记录未被覆盖。'));
      tx.onabort = () => reject(new Error('读取被中止，原有记录未被覆盖。'));
    });
    if (value === undefined) { expectedRevision = 0; return emptyLibrary(); }
    const library = validateLibrary(value, true);
    expectedRevision = storageRevision(value);
    return library;
  } finally { db.close(); }
}
export function saveLibrary(library: Library): Promise<void> {
  let snapshot: Library;
  try { snapshot = validateLibrary(library); }
  catch (error) { return Promise.reject(error); }
  const operation = queue.catch(() => undefined).then(async () => {
    if (expectedRevision === null) throw new Error('尚未成功读取本机方案，无法保存。请先重新读取或导出当前修改。');
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        let failure: Error | null = null;
        let writtenRevision: number | null = null;
        const abort = (error: Error) => { failure = error; try { tx.abort(); } catch { reject(error); } };
        tx.oncomplete = () => {
          if (writtenRevision === null) { reject(failure ?? new Error('保存未完成，原有记录未被覆盖。')); return; }
          expectedRevision = writtenRevision;
          resolve();
        };
        tx.onerror = () => reject(failure ?? new Error('保存失败：本机存储不可用或空间不足。请导出当前方案备份。'));
        tx.onabort = () => reject(failure ?? new Error('保存被中止。当前修改仍在页面中，请重试或导出备份。'));
        const store = tx.objectStore(STORE);
        const request = store.get(KEY);
        request.onsuccess = () => {
          try {
            const actualRevision = storageRevision(request.result);
            if (actualRevision !== expectedRevision) { abort(new StorageConflictError()); return; }
            writtenRevision = actualRevision + 1;
            store.put({ ...snapshot, storageRevision: writtenRevision }, KEY);
          } catch (error) { abort(error instanceof Error ? error : new Error('浏览器拒绝保存，请导出当前修改。')); }
        };
      });
    } finally { db.close(); }
  });
  queue = operation;
  return operation;
}
