import { GrayImage } from './image';
import { boxBlur } from './filters';

/** 自适应局部均值二值化:低于局部均值×系数为脊(0),否则为谷(255) */
export interface BinarizeParams {
  radius: number;
  /** 阈值 = 局部均值 × factor */
  factor: number;
}

export const DEFAULT_BINARIZE_PARAMS: BinarizeParams = { radius: 12, factor: 1.0 };

export function adaptiveBinarize(input: GrayImage, raw?: Partial<BinarizeParams>): GrayImage {
  const p = { ...DEFAULT_BINARIZE_PARAMS, ...raw };
  const local = boxBlur(input, p.radius);
  const out = new Float32Array(input.data.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = input.data[i] < local.data[i] * p.factor ? 0 : 255;
  }
  return new GrayImage(input.width, input.height, out);
}

/**
 * Zhang-Suen 细化,输出单像素骨架(脊=0,谷=255 约定下先反转处理)。
 * 返回值中骨架像素为 0,背景为 255,与二值图约定一致。
 */
export function zhangSuenThin(binary: GrayImage): GrayImage {
  const { width: w, height: h } = binary;
  // 反转:前景骨架 = 1
  let f = new Uint8Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = binary.data[i] < 128 ? 1 : 0;

  const step = (mark: number[], phase: 0 | 1): boolean => {
    let changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (f[i] !== 1) continue;
        const p2 = f[i - w], p3 = f[i - w + 1], p4 = f[i + 1], p5 = f[i + w + 1];
        const p6 = f[i + w], p7 = f[i + w - 1], p8 = f[i - 1], p9 = f[i - w - 1];
        const neighbors = [p2, p3, p4, p5, p6, p7, p8, p9];
        const b = neighbors.reduce((a, v) => a + v, 0);
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let k = 0; k < 8; k++) if (neighbors[k] === 0 && neighbors[(k + 1) % 8] === 1) a++;
        if (a !== 1) continue;
        const cond1 = p2 * p4 * p6 === 0;
        const cond2 = p4 * p6 * p8 === 0;
        const cond3 = p2 * p4 * p8 === 0;
        const cond4 = p2 * p6 * p8 === 0;
        if ((phase === 0 && cond1 && cond2) || (phase === 1 && cond3 && cond4)) {
          mark.push(i);
          changed = true;
        }
      }
    }
    for (const i of mark) f[i] = 0;
    return changed;
  };

  let changed = true;
  while (changed) {
    const m1: number[] = [];
    const c1 = step(m1, 0);
    const m2: number[] = [];
    const c2 = step(m2, 1);
    changed = c1 || c2;
  }

  const out = new Float32Array(w * h).fill(255);
  for (let i = 0; i < f.length; i++) if (f[i] === 1) out[i] = 0;
  return new GrayImage(w, h, out);
}
