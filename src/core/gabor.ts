import { GrayImage } from './image';
import { orientationAt, coherenceAt, type OrientationField } from './orientation';
import { frequencyAt, type FrequencyField } from './frequency';

/**
 * 方向 Gabor 滤波增强(需求 2)
 *
 * 偶对称 Gabor:h(x,y)=exp(-(x²/σx² + y²/σy²)/2)·cos(2πf·x)
 * x 轴为局部脊线法向。设计约束(防止"凭空造分叉点"):
 *   - 偶对称核不会移动或创造脊线相位,只在已有周期上加权;
 *   - 每个块的频率/方向全部来自局部场,核随场旋转,不会交叉产生伪脊;
 *   - 低相干区域(方向不可信)不做增强,原样保留;
 *   - σy 沿脊方向有限长度,断线处由沿脊方向的邻接像素接续(接断),
 *     但跨不过一个完整脊间距。
 *
 * 性能:方向/频率场以 blockSize 为粒度分段恒定,因此同一块共用一个
 * 预计算旋转核,把 O(像素 × 核²) 的逐像素三角运算降为每块一次核构造
 * + 每像素一次核内积,满足 1000dpi 图 ≤4s(需求 4)。
 */
export interface GaborParams {
  sigmaXFactor: number;
  sigmaYFactor: number;
  radiusFactor: number;
  coherenceGate: number;
  /** 块级核复用的网格大小(与方向场块对齐) */
  kernelBlockSize: number;
}

export const DEFAULT_GABOR_PARAMS: GaborParams = {
  sigmaXFactor: 0.5,
  sigmaYFactor: 0.5,
  radiusFactor: 3,
  coherenceGate: 0.15,
  kernelBlockSize: 16,
};

export interface GaborResult {
  image: GrayImage;
  gatedFraction: number;
}

interface Kernel {
  radius: number;
  /** 全局坐标偏移对应的权重 */
  weights: Float32Array;
  /** 与 weights 对齐的 dx,dy */
  dx: Int16Array;
  dy: Int16Array;
  count: number;
  weightSum: number;
}

function buildKernel(theta: number, f: number, p: GaborParams): Kernel {
  const period = 1 / f;
  const sigmaX = p.sigmaXFactor * period;
  const sigmaY = p.sigmaYFactor * period;
  const radius = Math.max(2, Math.round(p.radiusFactor * period));
  const nx = Math.cos(theta + Math.PI / 2);
  const ny = Math.sin(theta + Math.PI / 2);
  const tx = -ny;
  const ty = nx;
  const offsetsX: number[] = [];
  const offsetsY: number[] = [];
  const weights: number[] = [];
  let weightSum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gx = dx * nx + dy * ny; // 法向坐标
      const gy = dx * tx + dy * ty; // 脊向坐标
      const g =
        Math.exp(-0.5 * ((gx * gx) / (sigmaX * sigmaX) + (gy * gy) / (sigmaY * sigmaY))) *
        Math.cos(2 * Math.PI * f * gx);
      offsetsX.push(dx);
      offsetsY.push(dy);
      weights.push(g);
      weightSum += Math.abs(g);
    }
  }
  return {
    radius,
    weights: Float32Array.from(weights),
    dx: Int16Array.from(offsetsX),
    dy: Int16Array.from(offsetsY),
    count: weights.length,
    weightSum,
  };
}

export function gaborEnhance(
  input: GrayImage,
  of: OrientationField,
  ff: FrequencyField,
  raw?: Partial<GaborParams>,
): GaborResult {
  const p = { ...DEFAULT_GABOR_PARAMS, ...raw };
  const { width: w, height: h, data: src } = input;
  const out = new Float32Array(w * h);
  let gated = 0;
  const bs = p.kernelBlockSize;
  const cols = Math.ceil(w / bs);
  const rows = Math.ceil(h / bs);

  // 预计算每个块的核(块中心采样方向/频率,块内视为恒定)
  const kernels: Kernel[] = new Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const cx = Math.min(w - 1, (bx + 0.5) * bs);
      const cy = Math.min(h - 1, (by + 0.5) * bs);
      const theta = orientationAt(of, cx, cy);
      const f = frequencyAt(ff, cx, cy);
      kernels[by * cols + bx] = buildKernel(theta, f, p);
    }
  }

  for (let y = 0; y < h; y++) {
    const by = Math.min(rows - 1, Math.floor(y / bs));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (coherenceAt(of, x, y) < p.coherenceGate) {
        out[i] = src[i];
        gated++;
        continue;
      }
      const bx = Math.min(cols - 1, Math.floor(x / bs));
      const k = kernels[by * cols + bx];
      let acc = 0;
      for (let t = 0; t < k.count; t++) {
        acc += input.at(x + k.dx[t], y + k.dy[t]) * k.weights[t];
      }
      const response = k.weightSum > 0 ? acc / k.weightSum : src[i];
      out[i] = response < 0 ? 0 : response > 255 ? 255 : response;
    }
  }

  return {
    image: new GrayImage(w, h, out),
    gatedFraction: gated / (w * h),
  };
}
