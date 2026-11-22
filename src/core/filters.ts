import { GrayImage } from './image';

/** 一维高斯核(半径 radius,长度 2r+1),σ 缺省按 3σ≈r 估计 */
export function gaussianKernel1d(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  const twoVar = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / twoVar);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** 可分离高斯模糊,边界 clamp */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  if (sigma <= 0) return img.clone();
  const kernel = gaussianKernel1d(sigma);
  const r = (kernel.length - 1) >> 1;
  const w = img.width;
  const h = img.height;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const src = img.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        acc += src[y * w + xx] * kernel[k + r];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        acc += tmp[yy * w + x] * kernel[k + r];
      }
      out[y * w + x] = acc;
    }
  }
  return new GrayImage(w, h, out);
}

export interface Gradient {
  gx: Float32Array;
  gy: Float32Array;
  /** 梯度幅值 */
  mag: Float32Array;
}

/** Sobel 梯度 */
export function sobel(img: GrayImage): Gradient {
  const { width: w, height: h, data: s } = img;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = s[i - w - 1], t = s[i - w], tr = s[i - w + 1];
      const l = s[i - 1], r = s[i + 1];
      const bl = s[i + w - 1], b = s[i + w], br = s[i + w + 1];
      const vx = tr + 2 * r + br - (tl + 2 * l + bl);
      const vy = bl + 2 * b + br - (tl + 2 * t + tr);
      gx[i] = vx;
      gy[i] = vy;
      mag[i] = Math.hypot(vx, vy);
    }
  }
  return { gx, gy, mag };
}

/** 全局对比度归一化:减均值除标准差后线性映射回 0..255 */
export function normalizeGlobal(img: GrayImage): GrayImage {
  const { data: s } = img;
  let mean = 0;
  for (const v of s) mean += v;
  mean /= s.length;
  let variance = 0;
  for (const v of s) variance += (v - mean) * (v - mean);
  const sd = Math.sqrt(variance / s.length) || 1;
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const z = (s[i] - mean) / sd;
    out[i] = Math.max(0, Math.min(255, 128 + z * 52));
  }
  return new GrayImage(img.width, img.height, out);
}

/** 盒式模糊(用于局部均值/二值化),积分图实现 */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  const { width: w, height: h, data: s } = img;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += s[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum =
        integral[(y1 + 1) * stride + (x1 + 1)] -
        integral[y0 * stride + (x1 + 1)] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0];
      out[y * w + x] = sum / area;
    }
  }
  return new GrayImage(w, h, out);
}
