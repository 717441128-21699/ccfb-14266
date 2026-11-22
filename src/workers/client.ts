import type { PipelineParams } from '../core/pipeline-types';
import type { WorkerPayload, WorkerRequest, WorkerResponse } from './pipeline.worker';
import type { Minutia } from '../types';

/** Worker 客户端:封装消息往返,主线程只拿到可落库的阶段数据 */
export interface WorkerStage {
  name: string;
  durationMs: number;
  params: Record<string, number | string | boolean>;
  metrics: Record<string, number | string | number[]>;
  data: Float32Array;
  width: number;
  height: number;
}

export interface WorkerPipelineResult {
  totalMs: number;
  stages: WorkerStage[];
  minutiae: Minutia[];
  enhanced: { width: number; height: number; data: Float32Array };
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: WorkerResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data);
      }
    };
  }
  return worker;
}

export function runPipelineInWorker(
  width: number,
  height: number,
  data: Float32Array,
  imageId: string,
  params?: Partial<PipelineParams>,
): Promise<WorkerPipelineResult> {
  const w = getWorker();
  const id = nextId++;
  const req: WorkerRequest = { id, image: { width, height, data }, imageId, params };
  return new Promise((resolve, reject) => {
    pending.set(id, (res) => {
      if (!res.ok || !res.result) {
        reject(new Error(res.error ?? 'Worker 处理失败'));
        return;
      }
      const p: WorkerPayload = res.result;
      resolve({
        totalMs: p.totalMs,
        stages: p.stages.map((s) => ({ ...s, data: Float32Array.from(s.data) })),
        minutiae: p.minutiae,
        enhanced: { width: p.enhanced.width, height: p.enhanced.height, data: Float32Array.from(p.enhanced.data) },
      });
    });
    w.postMessage(req);
  });
}
