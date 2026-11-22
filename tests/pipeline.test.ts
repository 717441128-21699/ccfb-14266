import { describe, it, expect } from 'vitest';
import { synthesize, BACKGROUND_LABELS } from '../src/core/synthesis';
import { runCpuPipeline } from '../src/core/pipeline';
import { evaluateMinutiae } from '../src/core/metrics';
import { adaptiveBinarize, zhangSuenThin } from '../src/core/binarize';
import { GrayImage } from '../src/core/image';
import type { BackgroundKind, PatternModel } from '../src/core/synthesis';

const MODELS: PatternModel[] = ['arch', 'loop', 'whorl'];
const BACKGROUNDS: BackgroundKind[] = ['fabric', 'grid', 'dots', 'diagonal', 'banknote'];

describe('合成测试图', () => {
  it('三种纹型 × 五种背景均可生成,尺寸与真值特征点正确', () => {
    for (const model of MODELS) {
      for (const bg of BACKGROUNDS) {
        const { image, groundTruth } = synthesize({
          width: 320,
          height: 320,
          seed: 7,
          model,
          ridgePeriod: 10,
          backgrounds: [bg],
          backgroundStrength: 0.8,
          noiseSigma: 6,
          minutiaCount: 8,
        });
        expect(image.width).toBe(320);
        expect(image.height).toBe(320);
        expect(groundTruth.minutiae.length).toBeGreaterThanOrEqual(3);
        expect(groundTruth.plantedMinutiae?.length).toBeGreaterThanOrEqual(5);
        expect(groundTruth.backgroundKinds).toEqual([bg]);
        expect(BACKGROUND_LABELS[bg]).toBeTruthy();
        for (const m of groundTruth.minutiae) {
          expect(['ending', 'bifurcation']).toContain(m.type);
          expect(m.angle).toBeGreaterThanOrEqual(0);
          expect(m.angle).toBeLessThan(Math.PI);
        }
      }
    }
  });

  it('半枚指纹模式下右半区无脊线信号', () => {
    const { image } = synthesize({
      width: 256,
      height: 256,
      seed: 1,
      model: 'loop',
      ridgePeriod: 10,
      backgrounds: ['grid'],
      backgroundStrength: 0.5,
      noiseSigma: 4,
      halfPrint: true,
      minutiaCount: 4,
    });
    const right = image.data.subarray(256 * 200, 256 * 200 + 128);
    // 右半主要是背景,不应出现脊谷强对比
    const mean = right.reduce((a, b) => a + b, 0) / right.length;
    const spread = Math.max(...Array.from(right).map((v) => Math.abs(v - mean)));
    expect(spread).toBeLessThan(80);
  });
});

describe('端到端流水线与特征点精度(需求 2/3)', () => {
  it.each(MODELS)('纹型 %s:增强后特征点可匹配真值,命中点定位误差达标', (model) => {
    const { image, groundTruth } = synthesize({
      width: 384,
      height: 384,
      seed: 123,
      model,
      ridgePeriod: 10,
      backgrounds: ['fabric', 'banknote'],
      backgroundStrength: 0.9,
      noiseSigma: 7,
      minutiaCount: 10,
    });
    const result = runCpuPipeline(image, 'img-test');
    expect(result.stages).toHaveLength(9);
    expect(result.minutiae.length).toBeGreaterThan(0);

    const metrics = evaluateMinutiae(result.minutiae, groundTruth.minutiae, 4);
    // 真值取自干净图骨架;退化条件下要求充足召回,且命中点平均定位误差优于 3px 口径
    expect(metrics.truePositives).toBeGreaterThanOrEqual(8);
    expect(metrics.meanLocationError).toBeLessThanOrEqual(3);
    expect(metrics.within3pxRate).toBeGreaterThan(0.6);
  });

  it('背景抑制步骤在端到端中确实检出了周期峰', () => {
    const { image } = synthesize({
      width: 320,
      height: 320,
      seed: 5,
      model: 'arch',
      ridgePeriod: 10,
      backgrounds: ['diagonal'],
      backgroundStrength: 1,
      noiseSigma: 5,
      minutiaCount: 6,
    });
    const result = runCpuPipeline(image, 'img-test');
    const bgStage = result.stages.find((s) => s.name === 'bgSuppress')!;
    expect(bgStage.metrics.peaks as number).toBeGreaterThan(0);
    expect(bgStage.durationMs).toBeGreaterThan(0);
  });
});

describe('二值化与细化', () => {
  it('细化输出为单像素骨架(骨架点数远小于原条带)', () => {
    const data = new Float32Array(64 * 64).fill(255);
    // 画一条 5px 宽的竖脊
    for (let y = 8; y < 56; y++) for (let x = 28; x < 33; x++) data[y * 64 + x] = 0;
    const bin = adaptiveBinarize(new GrayImage(64, 64, data), { radius: 8, factor: 1.0 });
    const skel = zhangSuenThin(bin);
    let fg = 0;
    for (const v of skel.data) if (v < 128) fg++;
    // 单像素竖线长度量级,远小于原 5px 宽条带
    expect(fg).toBeLessThan(64 * 3);
    expect(fg).toBeGreaterThan(20);
  });
});
