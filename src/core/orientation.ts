import { GrayImage } from './image';
import { sobel, gaussianBlur } from './filters';
import { normAnglePi } from './util';

/**
 * 方向场估计(需求 2 第一步)
 * 梯度结构张量法:对每个 block 求 J = [Σgx² Σgxgy; Σgxgy Σgy²],
 * 主特征向量给出梯度方向,旋转 π/2 即脊线方向。
 * 双角(2θ)分量高斯平滑后再还原,保证 0/π 跳变处平滑。
 */
export interface OrientationField {
  /** block 网格列数/行数 */
  cols: number;
  rows: number;
  blockSize: number;
  /** 每个 block 的脊线方向 [0,π) */
  angles: Float32Array;
  /** 相干性 0..1,低相干区域方向不可信 */
  coherence: Float32Array;
  width: number;
  height: number;
}

export interface OrientationParams {
  blockSize: number;
  /** 双角场平滑 σ,单位为 block */
  smoothSigmaBlocks: number;
  coherenceMin: number;
}

export const DEFAULT_ORIENTATION_PARAMS: OrientationParams = {
  blockSize: 16,
  smoothSigmaBlocks: 1.2,
  coherenceMin: 0.18,
};

export function estimateOrientation(input: GrayImage, raw?: Partial<OrientationParams>): OrientationField {
  const p = { ...DEFAULT_ORIENTATION_PARAMS, ...raw };
  const { width: w, height: h } = input;
  const grad = sobel(input);
  const cols = Math.ceil(w / p.blockSize);
  const rows = Math.ceil(h / p.blockSize);
  const angles = new Float32Array(cols * rows);
  const coherence = new Float32Array(cols * rows);
  const phi2x = new Float32Array(cols * rows);
  const phi2y = new Float32Array(cols * rows);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * p.blockSize;
      const y0 = by * p.blockSize;
      const x1 = Math.min(w, x0 + p.blockSize);
      const y1 = Math.min(h, y0 + p.blockSize);
      let jxx = 0, jxy = 0, jyy = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          const gx = grad.gx[i];
          const gy = grad.gy[i];
          jxx += gx * gx;
          jxy += gx * gy;
          jyy += gy * gy;
        }
      }
      const bi = by * cols + bx;
      const diff = jxx - jyy;
      // 梯度主方向 *2
      const phi = 0.5 * Math.atan2(2 * jxy, diff);
      // 脊线方向 = 梯度方向 + π/2,双角表示下等价于加 π,即取反
      phi2x[bi] = Math.cos(2 * phi + Math.PI);
      phi2y[bi] = Math.sin(2 * phi + Math.PI);
      const tr = jxx + jyy;
      coherence[bi] = tr > 0 ? Math.sqrt(diff * diff + 4 * jxy * jxy) / tr : 0;
    }
  }

  // 双角场平滑
  const smoothPx = p.smoothSigmaBlocks;
  const smX = smoothField(phi2x, cols, rows, smoothPx);
  const smY = smoothField(phi2y, cols, rows, smoothPx);
  for (let i = 0; i < angles.length; i++) {
    angles[i] = normAnglePi(0.5 * Math.atan2(smY[i], smX[i]));
  }

  return { cols, rows, blockSize: p.blockSize, angles, coherence, width: w, height: h };
}

function smoothField(f: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const img = new GrayImage(cols, rows, Float32Array.from(f));
  return gaussianBlur(img, sigma).data;
}

/** 取像素坐标处的方向(双线性) */
export function orientationAt(of: OrientationField, x: number, y: number): number {
  const gx = x / of.blockSize - 0.5;
  const gy = y / of.blockSize - 0.5;
  const x0 = Math.max(0, Math.min(of.cols - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(of.rows - 1, Math.floor(gy)));
  const x1 = Math.min(of.cols - 1, x0 + 1);
  const y1 = Math.min(of.rows - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, gx - x0));
  const ty = Math.max(0, Math.min(1, gy - y0));
  // 双角域插值
  const sample = (cx: number, cy: number) => {
    const a = of.angles[cy * of.cols + cx] * 2;
    return { x: Math.cos(a), y: Math.sin(a) };
  };
  const a = sample(x0, y0), b = sample(x1, y0), c = sample(x0, y1), d = sample(x1, y1);
  const vx = (a.x * (1 - tx) + b.x * tx) * (1 - ty) + (c.x * (1 - tx) + d.x * tx) * ty;
  const vy = (a.y * (1 - tx) + b.y * tx) * (1 - ty) + (c.y * (1 - tx) + d.y * tx) * ty;
  return normAnglePi(0.5 * Math.atan2(vy, vx));
}

export function coherenceAt(of: OrientationField, x: number, y: number): number {
  const bx = Math.max(0, Math.min(of.cols - 1, Math.floor(x / of.blockSize)));
  const by = Math.max(0, Math.min(of.rows - 1, Math.floor(y / of.blockSize)));
  return of.coherence[by * of.cols + bx];
}
