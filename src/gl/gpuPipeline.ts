import { GlEngine, GlProgram } from './engine';
import { SHADERS } from './shaders';
import { GrayImage } from '../core/image';
import { gaussianKernel1d } from '../core/filters';
import { estimateOrientation, orientationAt, coherenceAt, type OrientationField } from '../core/orientation';
import { estimateFrequency, frequencyAt, type FrequencyField } from '../core/frequency';
import { suppressPeriodicBackground, type BgSuppressParams } from '../core/background';
import { zhangSuenThin } from '../core/binarize';
import { detectMinutiae, type MinutiaDetectParams } from '../core/minutiae';
import { normalizeGlobal, gaussianBlur } from '../core/filters';
import type { Minutia } from '../types';
import type { BinarizeParams, GaborParams } from '../core/pipeline-types';
import { DEFAULT_PIPELINE_PARAMS, type PipelineParams, type PipelineStage } from '../core/pipeline-types';

/**
 * GPU 加速流水线:
 *   CPU(Worker):FFT 背景抑制、方向场、频率场、细化与特征提取
 *   GPU(WebGL2):去噪、Gabor 增强、局部均值与二值化
 * 逐阶段计时,结构与 runCpuPipeline 对齐,留痕字段一致。
 */
export class GpuPipeline {
  private progs: Record<string, GlProgram>;

  constructor(private engine: GlEngine) {
    const gl = engine.gl;
    this.progs = {
      gaussian: new GlProgram(gl, SHADERS.gaussian),
      gabor: new GlProgram(gl, SHADERS.gabor),
      binarize: new GlProgram(gl, SHADERS.binarize),
      box: new GlProgram(gl, SHADERS.box),
      display: new GlProgram(gl, SHADERS.display),
    };
  }

  get displayProgram(): GlProgram {
    return this.progs.display;
  }

  run(input: GrayImage, imageId: string, raw?: Partial<PipelineParams>): {
    stages: PipelineStage[];
    orientation: OrientationField;
    frequency: FrequencyField;
    enhanced: GrayImage;
    binary: GrayImage;
    skeleton: GrayImage;
    minutiae: Minutia[];
    totalMs: number;
  } {
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

    // 1. 归一化(CPU,轻量)
    let t0 = performance.now();
    const normalized = normalizeGlobal(input);
    stages.push({ name: 'normalize', image: normalized, durationMs: performance.now() - t0, params: {}, metrics: {} });

    // 2. 高斯去噪(GPU 两遍)
    t0 = performance.now();
    const denoised = this.gpuGaussian(normalized, p.denoiseSigma);
    stages.push({
      name: 'denoise',
      image: denoised,
      durationMs: performance.now() - t0,
      params: { sigma: p.denoiseSigma, backend: 'webgl2' },
      metrics: {},
    });

    // 3. FFT 周期性背景抑制(CPU)
    t0 = performance.now();
    const bg = suppressPeriodicBackground(denoised, p.background as BgSuppressParams);
    stages.push({
      name: 'bgSuppress',
      image: bg.image,
      durationMs: performance.now() - t0,
      params: { ...p.background, backend: 'cpu-fft' },
      metrics: {
        peaks: bg.peaks.length,
        ridgeBandPeaks: bg.peaks.filter((q) => q.inRidgeBand).length,
        suppressedEnergyFraction: bg.suppressedEnergyFraction,
        peakFrequencies: bg.peaks.map((q) => Number(q.freq.toFixed(4))),
      },
    });

    // 4. 方向场 + 5. 频率场(CPU)
    t0 = performance.now();
    const orientation = estimateOrientation(bg.image, p.orientation);
    const frequency = estimateFrequency(bg.image, orientation, p.frequency);
    const fieldMs = performance.now() - t0;
    stages.push({
      name: 'orientation',
      image: bg.image,
      durationMs: fieldMs * 0.6,
      params: { ...p.orientation },
      metrics: { meanCoherence: avg(orientation.coherence) },
    });
    stages.push({
      name: 'frequency',
      image: bg.image,
      durationMs: fieldMs * 0.4,
      params: { ...p.frequency },
      metrics: { meanFreqCyclesPerPixel: avg(frequency.freq), meanRidgePeriodPx: 1 / avg(frequency.freq) },
    });

    // 6. 逐像素场展开并上传
    const fieldPacked = packField(bg.image, orientation, frequency);
    this.engine.upload(bg.image.data, bg.image.width, bg.image.height);
    this.engine.uploadField(fieldPacked, bg.image.width, bg.image.height);

    // 7. Gabor 增强(GPU)
    t0 = performance.now();
    const gp = p.gabor as GaborParams;
    const gaborProg = this.progs.gabor;
    gaborProg.use();
    this.engine.bindExtra(1, this.engine.getFieldTexture());
    this.engine.gl.uniform1i(gaborProg.uniform('u_field'), 1);
    this.engine.gl.uniform1f(gaborProg.uniform('u_sigmaXFactor'), gp.sigmaXFactor);
    this.engine.gl.uniform1f(gaborProg.uniform('u_sigmaYFactor'), gp.sigmaYFactor);
    this.engine.gl.uniform1f(gaborProg.uniform('u_radiusFactor'), gp.radiusFactor);
    this.engine.gl.uniform1f(gaborProg.uniform('u_coherenceGate'), gp.coherenceGate);
    this.engine.runPass(gaborProg, () => {});
    const gaborMs = performance.now() - t0;
    const enhancedData = this.engine.readback();
    const enhanced = new GrayImage(bg.image.width, bg.image.height, enhancedData);
    stages.push({
      name: 'gabor',
      image: enhanced,
      durationMs: gaborMs,
      params: { ...gp, backend: 'webgl2' },
      metrics: {},
    });

    // 8. 局部均值(可分离 box 两遍,落到专用均值纹理)+ GPU 二值化
    t0 = performance.now();
    const bp = p.binarize as BinarizeParams;
    const box = this.progs.box;
    box.use();
    this.engine.gl.uniform1i(box.uniform('u_radius'), bp.radius);
    this.engine.gl.uniform1i(box.uniform('u_horizontal'), 1);
    this.engine.runPass(box, () => {}); // texA = 水平均值
    box.use();
    this.engine.gl.uniform1i(box.uniform('u_radius'), bp.radius);
    this.engine.gl.uniform1i(box.uniform('u_horizontal'), 0);
    this.engine.runPass(box, () => {}, false); // 垂直均值写入 texB,不交换
    this.engine.copyTexBToMean();
    const binProg = this.progs.binarize;
    binProg.use();
    this.engine.bindExtra(1, this.engine.getMeanTexture());
    this.engine.gl.uniform1i(binProg.uniform('u_mean'), 1);
    this.engine.gl.uniform1f(binProg.uniform('u_factor'), bp.factor);
    this.engine.runPass(binProg, () => {}); // texA 仍是增强图,输出二值并交换
    const binaryData = this.engine.readback();
    const binary = new GrayImage(enhanced.width, enhanced.height, binaryData);
    stages.push({
      name: 'binarize',
      image: binary,
      durationMs: performance.now() - t0,
      params: { ...bp, backend: 'webgl2' },
      metrics: { ridgePixelFraction: ridgeFraction(binary) },
    });

    // 9. 细化(CPU,迭代型不适合单 pass)
    t0 = performance.now();
    const skeleton = zhangSuenThin(binary);
    stages.push({ name: 'thin', image: skeleton, durationMs: performance.now() - t0, params: { backend: 'cpu' }, metrics: {} });

    // 10. 特征点(CPU)
    t0 = performance.now();
    const minutiae = detectMinutiae(skeleton, orientation, imageId, p.minutia as MinutiaDetectParams);
    stages.push({
      name: 'minutiae',
      image: skeleton,
      durationMs: performance.now() - t0,
      params: { ...p.minutia },
      metrics: {
        endings: minutiae.filter((m) => m.type === 'ending').length,
        bifurcations: minutiae.filter((m) => m.type === 'bifurcation').length,
      },
    });

    return {
      stages,
      orientation,
      frequency,
      enhanced,
      binary,
      skeleton,
      minutiae,
      totalMs: stages.reduce((s, x) => s + x.durationMs, 0),
    };
  }

  private gpuGaussian(img: GrayImage, sigma: number): GrayImage {
    if (sigma <= 0) return img.clone();
    const kernel = gaussianKernel1d(sigma);
    const radius = (kernel.length - 1) >> 1;
    if (radius > 15) return gaussianBlur(img, sigma); // 核过大走 CPU 保底
    const padded = new Float32Array(31);
    padded.set(kernel, 15 - radius);
    const prog = this.progs.gaussian;
    this.engine.upload(img.data, img.width, img.height);
    prog.use();
    this.engine.gl.uniform1fv(prog.uniform('u_kernel'), padded);
    this.engine.gl.uniform1i(prog.uniform('u_radius'), radius);
    this.engine.gl.uniform1i(prog.uniform('u_horizontal'), 1);
    this.engine.runPass(prog, () => {});
    prog.use();
    this.engine.gl.uniform1fv(prog.uniform('u_kernel'), padded);
    this.engine.gl.uniform1i(prog.uniform('u_radius'), radius);
    this.engine.gl.uniform1i(prog.uniform('u_horizontal'), 0);
    this.engine.runPass(prog, () => {});
    return new GrayImage(img.width, img.height, this.engine.readback());
  }
}

/** 逐像素打包方向(双角分量)/频率/相干性到 RGBA */
function packField(img: GrayImage, of: OrientationField, ff: FrequencyField): Float32Array {
  const out = new Float32Array(img.width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const theta = orientationAt(of, x, y);
      const i = (y * img.width + x) * 4;
      out[i] = Math.cos(2 * theta);
      out[i + 1] = Math.sin(2 * theta);
      out[i + 2] = frequencyAt(ff, x, y);
      out[i + 3] = coherenceAt(of, x, y);
    }
  }
  return out;
}

function avg(a: Float32Array | Uint8Array): number {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}
function ridgeFraction(img: GrayImage): number {
  let n = 0;
  for (const v of img.data) if (v < 128) n++;
  return n / img.data.length;
}
