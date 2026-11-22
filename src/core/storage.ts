import type {
  BlobRecord,
  CaseRecord,
  Evidence,
  FpImage,
  ID,
  Minutia,
  MinutiaChange,
  ProcessingStep,
} from '../types';
import { uid } from './util';

const DB_NAME = 'latent-print-workbench';
const DB_VERSION = 1;

const STORES = {
  cases: 'cases',
  evidences: 'evidences',
  images: 'images',
  steps: 'steps',
  minutiae: 'minutiae',
  changes: 'minutiaChanges',
  blobs: 'blobs',
} as const;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.cases)) db.createObjectStore(STORES.cases, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.evidences)) {
        const s = db.createObjectStore(STORES.evidences, { keyPath: 'id' });
        s.createIndex('caseId', 'caseId');
      }
      if (!db.objectStoreNames.contains(STORES.images)) {
        const s = db.createObjectStore(STORES.images, { keyPath: 'id' });
        s.createIndex('evidenceId', 'evidenceId');
      }
      if (!db.objectStoreNames.contains(STORES.steps)) {
        const s = db.createObjectStore(STORES.steps, { keyPath: 'id' });
        s.createIndex('imageId', 'imageId');
        s.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains(STORES.minutiae)) {
        const s = db.createObjectStore(STORES.minutiae, { keyPath: 'id' });
        s.createIndex('imageId', 'imageId');
      }
      if (!db.objectStoreNames.contains(STORES.changes)) {
        const s = db.createObjectStore(STORES.changes, { keyPath: 'id' });
        s.createIndex('imageId', 'imageId');
      }
      if (!db.objectStoreNames.contains(STORES.blobs)) db.createObjectStore(STORES.blobs, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const storage = {
  // ---- 案件 ----
  async putCase(c: CaseRecord): Promise<void> {
    await tx(STORES.cases, 'readwrite', (s) => s.put(c));
  },
  listCases(): Promise<CaseRecord[]> {
    return tx(STORES.cases, 'readonly', (s) => s.getAll() as IDBRequest<CaseRecord[]>);
  },
  async deleteCase(id: ID): Promise<void> {
    const evidences = await this.listEvidences(id);
    for (const ev of evidences) await this.deleteEvidence(ev.id);
    await tx(STORES.cases, 'readwrite', (s) => s.delete(id));
  },

  // ---- 物证 ----
  async putEvidence(e: Evidence): Promise<void> {
    await tx(STORES.evidences, 'readwrite', (s) => s.put(e));
  },
  async listEvidences(caseId?: ID): Promise<Evidence[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORES.evidences, 'readonly');
      const s = t.objectStore(STORES.evidences);
      const r = caseId ? s.index('caseId').getAll(caseId) : s.getAll();
      r.onsuccess = () => resolve(r.result as Evidence[]);
      r.onerror = () => reject(r.error);
    });
  },
  async getEvidence(id: ID): Promise<Evidence | undefined> {
    return tx(STORES.evidences, 'readonly', (s) => s.get(id) as IDBRequest<Evidence | undefined>);
  },
  async deleteEvidence(id: ID): Promise<void> {
    const d = await db();
    const imgs = await this.listImages(id);
    for (const img of imgs) {
      const steps = await this.listSteps(img.id);
      for (const st of steps) await this.deleteBlob(st.snapshotKey);
      await this.deleteBlob(img.originalKey);
      await this.deleteBlob(img.currentKey);
      await new Promise<void>((res, rej) => {
        const t = d.transaction([STORES.steps, STORES.minutiae, STORES.changes], 'readwrite');
        t.objectStore(STORES.steps).index('imageId').openCursor(IDBKeyRange.only(img.id)).onsuccess = (e) => {
          const cur = (e.target as IDBRequest).result as IDBCursorWithValue | null;
          if (cur) {
            cur.delete();
            cur.continue();
          }
        };
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
      await new Promise<void>((res, rej) => {
        const t = d.transaction([STORES.minutiae, STORES.changes], 'readwrite');
        for (const name of [STORES.minutiae, STORES.changes]) {
          t.objectStore(name).index('imageId').openCursor(IDBKeyRange.only(img.id)).onsuccess = (e) => {
            const cur = (e.target as IDBRequest).result as IDBCursorWithValue | null;
            if (cur) {
              cur.delete();
              cur.continue();
            }
          };
        }
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
      await tx(STORES.images, 'readwrite', (s) => s.delete(img.id));
    }
    await tx(STORES.evidences, 'readwrite', (s) => s.delete(id));
  },

  // ---- 图像 ----
  async putImage(img: FpImage): Promise<void> {
    await tx(STORES.images, 'readwrite', (s) => s.put(img));
  },
  async listImages(evidenceId?: ID): Promise<FpImage[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORES.images, 'readonly');
      const s = t.objectStore(STORES.images);
      const r = evidenceId ? s.index('evidenceId').getAll(evidenceId) : s.getAll();
      r.onsuccess = () => resolve(r.result as FpImage[]);
      r.onerror = () => reject(r.error);
    });
  },
  async getImage(id: ID): Promise<FpImage | undefined> {
    return tx(STORES.images, 'readonly', (s) => s.get(id) as IDBRequest<FpImage | undefined>);
  },

  // ---- 处理步骤 ----
  async addStep(step: ProcessingStep): Promise<void> {
    await tx(STORES.steps, 'readwrite', (s) => s.put(step));
  },
  async listSteps(imageId: ID): Promise<ProcessingStep[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORES.steps, 'readonly');
      const r = t.objectStore(STORES.steps).index('imageId').getAll(imageId);
      r.onsuccess = () => resolve((r.result as ProcessingStep[]).sort((a, b) => a.order - b.order));
      r.onerror = () => reject(r.error);
    });
  },

  // ---- 特征点 ----
  async putMinutia(m: Minutia): Promise<void> {
    await tx(STORES.minutiae, 'readwrite', (s) => s.put(m));
  },
  async bulkPutMinutia(list: Minutia[]): Promise<void> {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORES.minutiae, 'readwrite');
      const s = t.objectStore(STORES.minutiae);
      for (const m of list) s.put(m);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async listMinutiae(imageId: ID): Promise<Minutia[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORES.minutiae, 'readonly');
      const r = t.objectStore(STORES.minutiae).index('imageId').getAll(imageId);
      r.onsuccess = () => resolve(r.result as Minutia[]);
      r.onerror = () => reject(r.error);
    });
  },
  async deleteMinutia(id: ID): Promise<void> {
    await tx(STORES.minutiae, 'readwrite', (s) => s.delete(id));
  },
  async replaceMinutiae(imageId: ID, list: Minutia[]): Promise<void> {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORES.minutiae, 'readwrite');
      const s = t.objectStore(STORES.minutiae);
      s.index('imageId').openCursor(IDBKeyRange.only(imageId)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
      t.oncomplete = () => {
        const t2 = d.transaction(STORES.minutiae, 'readwrite');
        for (const m of list) t2.objectStore(STORES.minutiae).put(m);
        t2.oncomplete = () => resolve();
        t2.onerror = () => reject(t2.error);
      };
      t.onerror = () => reject(t.error);
    });
  },

  // ---- 改动记录(只追加) ----
  async addChange(c: MinutiaChange): Promise<void> {
    await tx(STORES.changes, 'readwrite', (s) => s.put(c));
  },
  async listChanges(imageId: ID): Promise<MinutiaChange[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORES.changes, 'readonly');
      const r = t.objectStore(STORES.changes).index('imageId').getAll(imageId);
      r.onsuccess = () =>
        resolve((r.result as MinutiaChange[]).sort((a, b) => a.at - b.at));
      r.onerror = () => reject(r.error);
    });
  },

  // ---- Blob 快照 ----
  async putBlob(key: string, blob: Blob, mime: string): Promise<void> {
    const rec: BlobRecord = { key, blob, mime, createdAt: Date.now() };
    await tx(STORES.blobs, 'readwrite', (s) => s.put(rec));
  },
  async getBlob(key: string): Promise<Blob | undefined> {
    const rec = await tx(STORES.blobs, 'readonly', (s) => s.get(key) as IDBRequest<BlobRecord | undefined>);
    return rec?.blob;
  },
  async deleteBlob(key: string): Promise<void> {
    await tx(STORES.blobs, 'readwrite', (s) => s.delete(key));
  },
};

export function newKey(prefix: string): string {
  return `${prefix}_${uid('b').slice(2)}`;
}
