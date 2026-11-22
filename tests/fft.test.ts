import { describe, it, expect } from 'vitest';
import { fft1dTest } from './fft-helper';
import { fft2d, forwardFft, inverseFft, nextPow2 } from '../src/core/fft';
import { GrayImage } from '../src/core/image';

describe('FFT', () => {
  it('nextPow2 返回不小于输入的最小 2 的幂', () => {
    expect(nextPow2(1)).toBe(2);
    expect(nextPow2(16)).toBe(16);
    expect(nextPow2(17)).toBe(32);
    expect(nextPow2(1000)).toBe(1024);
  });

  it('一维 FFT:直流信号能量集中在 0 频', () => {
    const n = 64;
    const re = new Float32Array(n).fill(7);
    const im = new Float32Array(n);
    fft1dTest(re, im, false);
    expect(Math.abs(re[0] - 7 * n)).toBeLessThan(1e-3);
    for (let k = 1; k < n; k++) expect(Math.abs(re[k])).toBeLessThan(1e-3);
  });

  it('一维 FFT:已知频率正弦产生两个对称峰', () => {
    const n = 128;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const k0 = 8;
    for (let i = 0; i < n; i++) re[i] = 3 * Math.sin((2 * Math.PI * k0 * i) / n);
    fft1dTest(re, im, false);
    expect(Math.abs(Math.hypot(re[k0], im[k0]))).toBeCloseTo(1.5 * n, 1);
    expect(Math.abs(Math.hypot(re[n - k0], im[n - k0]))).toBeCloseTo(1.5 * n, 1);
  });

  it('二维 FFT 正反变换可还原原图', () => {
    const w = 64;
    const h = 32;
    const src = new Float32Array(w * h);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) % 13 - 6;
    const buf = forwardFft(new GrayImage(w, h, Float32Array.from(src)));
    const back = inverseFft(buf);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(back[y * buf.cols + x]).toBeCloseTo(src[y * w + x], 3);
      }
    }
  });

  it('fft2d 支持独立缓冲实例', () => {
    const re = new Float32Array(4);
    const im = new Float32Array(4);
    re[0] = 1;
    fft2d({ rows: 2, cols: 2, re, im }, false);
    expect(re[0]).toBeCloseTo(1, 5);
  });
});
