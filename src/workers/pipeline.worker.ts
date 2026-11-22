/// <reference lib="webworker" />
import { GrayImage } from '../core/image';
import { runCpuPipeline, type PipelineResult } from '../core/pipeline';
import type { PipelineParams } from '../core/pipeline-types';

/**
 * 流水线 Worker:FFT、方向/频率场、细化与特征提取全部在后台线程,
 * 主线程只负责上传图像与回收计时结果,保证界面不卡顿(需求 4)。
 */
export interface WorkerRequest {
  id: number;
  image: { width: number; height: number; data: Float32Array };
  imageId: string;
  params?: Partial<PipelineParams>;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
  result?: WorkerPayload;
}

export interface WorkerPayload {
  totalMs: number;
  stages: {
    name: string;
    durationMs: number;
    params: Record<string, number | string | boolean>;
    metrics: Record<string, number | string | number[]>;
    data: Float32Array;
    width: number;
    height: number;
  }[];
  minutiae: PipelineResult['minutiae'];
  enhanced: { width: number; height: number; data: Float32Array };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const img = new GrayImage(req.image.width, req.image.height, Float32Array.from(req.image.data));
    const result = runCpuPipeline(img, req.imageId, req.params);
    const payload: WorkerPayload = {
      totalMs: result.totalMs,
      stages: result.stages.map((s) => ({
        name: s.name,
        durationMs: s.durationMs,
        params: s.params,
        metrics: s.metrics,
        data: s.image.data,
        width: s.image.width,
        height: s.image.height,
      })),
      minutiae: result.minutiae,
      enhanced: { width: result.enhanced.width, height: result.enhanced.height, data: result.enhanced.data },
    };
    const res: WorkerResponse = { id: req.id, ok: true, result: payload };
    ctx.postMessage(res);
  } catch (e) {
    const res: WorkerResponse = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    ctx.postMessage(res);
  }
};
