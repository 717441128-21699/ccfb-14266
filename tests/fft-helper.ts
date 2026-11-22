// 暴露一维 FFT 给测试(模块内未单独导出,用 1xN 二维 FFT 等价验证)
import { fft2d } from '../src/core/fft';

export function fft1dTest(re: Float32Array, im: Float32Array, inverse: boolean): void {
  // rows=1 时行变换即一维变换
  fft2d({ rows: 1, cols: re.length, re, im }, inverse);
}
