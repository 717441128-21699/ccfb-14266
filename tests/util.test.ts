import { describe, it, expect } from 'vitest';
import { angleDiff, normAnglePi, makeRng, clamp } from '../src/core/util';

describe('工具函数', () => {
  it('无极性角度差落在 [0, π/2]', () => {
    expect(angleDiff(0, Math.PI)).toBeCloseTo(0, 6);
    expect(angleDiff(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
    expect(angleDiff(0.2, Math.PI + 0.2)).toBeCloseTo(0, 6);
    expect(angleDiff(2.8, 0.1)).toBeLessThan(0.5);
  });

  it('normAnglePi 归一化到 [0,π)', () => {
    expect(normAnglePi(-0.5)).toBeCloseTo(Math.PI - 0.5, 6);
    expect(normAnglePi(Math.PI + 0.3)).toBeCloseTo(0.3, 6);
  });

  it('mulberry32 可复现', () => {
    const a = makeRng(99);
    const b = makeRng(99);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('clamp 边界正确', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
