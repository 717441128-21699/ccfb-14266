import { GrayImage } from './image';
import { normalizeGlobal, gaussianBlur } from './filters';
import { suppressPeriodicBackground } from './background';
import { estimateOrientation, type OrientationField } from './orientation';
import { estimateFrequency, type FrequencyField } from './frequency';
import { gaborEnhance } from './gabor';
import { adaptiveBinarize, zhangSuenThin } from './binarize';
import { detectMinutiae } from './minutiae';
import type { Minutia } from '../types';
import {
  DEFAULT_PIPELINE_PARAMS,
  type PipelineParams,
  type PipelineStage,
} from './pipeline-types';

export { DEFAULT_PIPELINE_PARAMS };
export type { PipelineParams, PipelineStage };

export interface PipelineResult {
  stages: PipelineStage[];
  orientation: OrientationField;
  frequency: FrequencyField;
  enhanced: GrayImage;
  binary: GrayImage;
  skeleton: GrayImage;
  minutiae: Minutia[];
  totalMs: number;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

/** CPU 鍙傝€冩祦姘寸嚎(鍚屾椂鏄?Node 娴嬭瘯涓?WebGL2 涓嶅彲鐢ㄦ椂鐨勯檷绾ц矾寰? */
export function runCpuPipeline(input: GrayImage, imageId: string, raw?: Partial<PipelineParams>): PipelineResult {
  const p: PipelineParams = {
    ...DEFAULT_PIPELINE_PARAMS,
    ...raw,
    background: { ...DEFAULT_PIPELINE_PARAMS.background, ...raw?.background },
    orientation: { ...DEFAULT_PIPELINE_PARAMS.orientation, ...raw?.orientation },
    frequency: { ...DEFAULT_PIPELINE_PARAMS.frequency, ...raw?.frequency },
    gabor: { ...DEFAULT_PIPELINE_PARAMS.gabor, ...raw?.gabor },
    binarize: { ...DEFAULT_PIPELINE_PARAMS.binarize, ...raw?.binarize },
    minutia: { ...DEFAULT_PIPELINE_PARAMS.minutia, ...raw?.minutia },
  };
  const stages: PipelineStage[] = [];

  const norm = timed(() => normalizeGlobal(input));
  stages.push({ name: 'normalize', image: norm.value, durationMs: norm.ms, params: {}, metrics: {} });

  const den = timed(() => gaussianBlur(norm.value, p.denoiseSigma));
  stages.push({
    name: 'denoise',
    image: den.value,
    durationMs: den.ms,
    params: { sigma: p.denoiseSigma },
    metrics: {},
  });

  const bg = timed(() => suppressPeriodicBackground(den.value, p.background));
  stages.push({
    name: 'bgSuppress',
    image: bg.value.image,
    durationMs: bg.ms,
    params: { ...p.background },
    metrics: {
      peaks: bg.value.peaks.length,
      ridgeBandPeaks: bg.value.peaks.filter((q) => q.inRidgeBand).length,
      suppressedEnergyFraction: bg.value.suppressedEnergyFraction,
      peakFrequencies: bg.value.peaks.map((q) => Number(q.freq.toFixed(4))),
    },
  });

  const ori = timed(() => estimateOrientation(bg.value.image, p.orientation));
  stages.push({
    name: 'orientation',
    image: bg.value.image,
    durationMs: ori.ms,
    params: { ...p.orientation },
    metrics: {
      meanCoherence: avg(ori.value.coherence),
      lowCoherenceBlocks: countLow(ori.value),
    },
  });

  const frq = timed(() => estimateFrequency(bg.value.image, ori.value, p.frequency));
  stages.push({
    name: 'frequency',
    image: bg.value.image,
    durationMs: frq.ms,
    params: { ...p.frequency },
    metrics: {
      meanFreqCyclesPerPixel: avg(frq.value.freq),
      meanRidgePeriodPx: 1 / avg(frq.value.freq),
      invalidBlocksFilled: frq.value.freq.length - countValid(frq.value),
    },
  });

  const gab = timed(() => gaborEnhance(bg.value.image, ori.value, frq.value, p.gabor));
  stages.push({
    name: 'gabor',
    image: gab.value.image,
    durationMs: gab.ms,
    params: { ...p.gabor },
    metrics: { gatedFraction: gab.value.gatedFraction },
  });

  const bin = timed(() => adaptiveBinarize(gab.value.image, p.binarize));
  stages.push({
    name: 'binarize',
    image: bin.value,
    durationMs: bin.ms,
    params: { ...p.binarize },
    metrics: { ridgePixelFraction: ridgeFraction(bin.value) },
  });

  const thin = timed(() => zhangSuenThin(bin.value));
  stages.push({ name: 'thin', image: thin.value, durationMs: thin.ms, params: {}, metrics: {} });

  const min = timed(() => detectMinutiae(thin.value, ori.value, imageId, p.minutia));
  stages.push({
    name: 'minutiae',
    image: thin.value,
    durationMs: min.ms,
    params: { ...p.minutia },
    metrics: {
      endings: min.value.filter((m) => m.type === 'ending').length,
      bifurcations: min.value.filter((m) => m.type === 'bifurcation').length,
    },
  });

  return {
    stages,
    orientation: ori.value,
    frequency: frq.value,
    enhanced: gab.value.image,
    binary: bin.value,
    skeleton: thin.value,
    minutiae: min.value,
    totalMs: stages.reduce((s, x) => s + x.durationMs, 0),
  };
}

function avg(a: Float32Array | Uint8Array): number {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}
function countLow(of: OrientationField): number {
  let n = 0;
  for (const c of of.coherence) if (c < 0.18) n++;
  return n;
}
function countValid(ff: FrequencyField): number {
  let n = 0;
  for (const v of ff.valid) if (v) n++;
  return n;
}
function ridgeFraction(img: GrayImage): number {
  let n = 0;
  for (const v of img.data) if (v < 128) n++;
  return n / img.data.length;
}

