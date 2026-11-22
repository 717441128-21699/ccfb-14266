import { describe, it, expect } from 'vitest';
import { GrayImage } from '../src/core/image';
import { makeRng } from '../src/core/util';
import { suppressPeriodicBackground } from '../src/core/background';

/** 纯正弦周期纹理:频谱上只有一对共轭峰,抑制后方差应大幅下降 */
function sinePlate(w: number, h: number, period: number, angle: number, amp: number): GrayImage {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x * Math.cos(angle) + y * Math.sin(angle);
      data[y * w + x] = 128 + amp * Math.sin((2 * Math.PI * u) / period);
    }
  }
  return new GrayImage(w, h, data);
}

describe('周期性背景抑制(需求 1)', () => {
  it('检出带外正弦周期峰并显著降低周期能量', () => {
    // 周期 40px → 0.025 周/像素,在脊线保护带之外,可深度陷波
    const img = sinePlate(256, 256, 40, Math.PI / 5, 50);
    const res = suppressPeriodicBackground(img);
    expect(res.peaks.length).toBeGreaterThanOrEqual(2);
    const before = variance(img.data);
    const after = variance(res.image.data);
    expect(after / before).toBeLessThan(0.25);
  });

  it('脊线频带内的峰被标记为保护对象,保留率显著高于带外深度陷波', () => {
    // 周期 8px → 频率 0.125,落在默认脊线带 [0.06,0.25]
    const inBand = sinePlate(256, 256, 8, 0, 40);
    const resIn = suppressPeriodicBackground(inBand);
    const protectedPeaks = resIn.peaks.filter((p) => p.inRidgeBand);
    expect(protectedPeaks.length).toBeGreaterThan(0);
    for (const pk of protectedPeaks) {
      expect(pk.gain).toBeGreaterThan(0.4); // 温和,不压掉脊线频率
      expect(pk.gain).toBeLessThan(1); // 但确实施加了衰减
    }
    const retainIn = variance(resIn.image.data) / variance(inBand.data);

    // 同幅度的带外周期信号(周期 40px)应被深度抑制
    const outBand = sinePlate(256, 256, 40, 0, 40);
    const resOut = suppressPeriodicBackground(outBand);
    const retainOut = variance(resOut.image.data) / variance(outBand.data);

    // 保护语义:带内能量保留率明显高于带外
    expect(retainIn).toBeGreaterThan(retainOut * 2);
    expect(retainOut).toBeLessThan(0.25);
  });

  it('带外周期峰采用深度陷波', () => {
    // 周期 40px → 0.025,在脊线带外
    const img = sinePlate(256, 256, 40, 0.3, 45);
    const res = suppressPeriodicBackground(img);
    const outer = res.peaks.filter((p) => !p.inRidgeBand);
    expect(outer.length).toBeGreaterThan(0);
    for (const pk of outer) expect(pk.gain).toBeLessThan(0.1);
  });

  it('无周期纹理的自然噪声不产生误陷波', () => {
    const rng = makeRng(42);
    const data = new Float32Array(256 * 256);
    for (let i = 0; i < data.length; i++) data[i] = 128 + (rng() - 0.5) * 30;
    const img = new GrayImage(256, 256, data);
    const res = suppressPeriodicBackground(img);
    expect(res.suppressedEnergyFraction).toBeLessThan(0.02);
  });
});

function variance(a: Float32Array): number {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let v = 0;
  for (const x of a) v += (x - m) ** 2;
  return v / a.length;
}
