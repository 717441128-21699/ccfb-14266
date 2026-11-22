import { describe, it, expect } from 'vitest';
import { GrayImage } from '../src/core/image';
import { estimateOrientation } from '../src/core/orientation';
import { estimateFrequency } from '../src/core/frequency';
import { angleDiff } from '../src/core/util';

/** 定向平行正弦脊:方向与频率均已知 */
function parallelRidges(w: number, h: number, period: number, theta: number): GrayImage {
  const data = new Float32Array(w * h);
  const nx = Math.cos(theta + Math.PI / 2);
  const ny = Math.sin(theta + Math.PI / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x * nx + y * ny;
      data[y * w + x] = 128 + 60 * Math.cos((2 * Math.PI * u) / period);
    }
  }
  return new GrayImage(w, h, data);
}

describe('方向场与频率场(需求 2)', () => {
  it('水平脊(θ=0)方向估计误差小于 8°', () => {
    const img = parallelRidges(128, 128, 10, 0);
    const of = estimateOrientation(img);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < of.angles.length; i++) {
      if (of.coherence[i] > 0.3) {
        sum += angleDiff(of.angles[i], 0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(of.angles.length * 0.5);
    expect((sum / n) * 180 / Math.PI).toBeLessThan(8);
  });

  it('45° 斜脊方向估计误差小于 10°', () => {
    const theta = Math.PI / 4;
    const img = parallelRidges(128, 128, 10, theta);
    const of = estimateOrientation(img);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < of.angles.length; i++) {
      if (of.coherence[i] > 0.3) {
        sum += angleDiff(of.angles[i], theta);
        n++;
      }
    }
    expect((sum / n) * 180 / Math.PI).toBeLessThan(10);
  });

  it('频率场在周期 10px 时给出 0.1±15% 的估计', () => {
    const img = parallelRidges(128, 128, 10, 0);
    const of = estimateOrientation(img);
    const ff = estimateFrequency(img, of);
    let sum = 0;
    for (const f of ff.freq) sum += f;
    const mean = sum / ff.freq.length;
    expect(mean).toBeGreaterThan(0.085);
    expect(mean).toBeLessThan(0.115);
  });

  it('频率场对无效块做填充,输出无零值', () => {
    const img = parallelRidges(96, 96, 12, 0.2);
    const of = estimateOrientation(img);
    const ff = estimateFrequency(img, of);
    for (const f of ff.freq) expect(f).toBeGreaterThan(0);
  });
});
