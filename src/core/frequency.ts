import { GrayImage } from './image';
import { orientationAt, type OrientationField } from './orientation';

/**
 * 频率场估计(需求 2 第二步)
 * 对每个 block,沿局部脊线法向投影得到一维灰度波形,
 * 波峰间距(像素/周期)的倒数即空间频率(周/像素)。
 * 无效 block 用邻域有效值中位数填充,保证后续 Gabor 处处可用。
 */
export interface FrequencyField {
  cols: number;
  rows: number;
  blockSize: number;
  /** 周/像素;0 表示无效 */
  freq: Float32Array;
  valid: Uint8Array;
  width: number;
  height: number;
}

export interface FrequencyParams {
  blockSize: number;
  minFreq: number;
  maxFreq: number;
  /** 投影采样窗口半长(像素) */
  windowRadius: number;
}

export const DEFAULT_FREQUENCY_PARAMS: FrequencyParams = {
  blockSize: 16,
  minFreq: 0.06,
  maxFreq: 0.25,
  windowRadius: 28,
};

export function estimateFrequency(
  input: GrayImage,
  of: OrientationField,
  raw?: Partial<FrequencyParams>,
): FrequencyField {
  const p = { ...DEFAULT_FREQUENCY_PARAMS, ...raw };
  const cols = of.cols;
  const rows = of.rows;
  const freq = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const cx = Math.min(input.width - 1, (bx + 0.5) * p.blockSize);
      const cy = Math.min(input.height - 1, (by + 0.5) * p.blockSize);
      const theta = orientationAt(of, cx, cy);
      // 脊线法向
      const nx = Math.cos(theta + Math.PI / 2);
      const ny = Math.sin(theta + Math.PI / 2);

      const profile: number[] = [];
      const r = p.windowRadius;
      for (let t = -r; t <= r; t++) {
        profile.push(input.sample(cx + nx * t, cy + ny * t));
      }
      const estimate = peakSpacing(profile);
      const bi = by * cols + bx;
      if (estimate > 0) {
        const f = 1 / estimate;
        if (f >= p.minFreq && f <= p.maxFreq) {
          freq[bi] = f;
          valid[bi] = 1;
        }
      }
    }
  }

  // 无效块用 3x3 邻域中位数迭代填充(最多 6 轮,覆盖大空洞)
  for (let round = 0; round < 6; round++) {
    let filledAny = false;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const bi = by * cols + bx;
        if (valid[bi]) continue;
        const neighbors: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = by + dy;
            const nx = bx + dx;
            if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
            const ni = ny * cols + nx;
            if (valid[ni]) neighbors.push(freq[ni]);
          }
        }
        if (neighbors.length >= 3) {
          neighbors.sort((a, b) => a - b);
          freq[bi] = neighbors[neighbors.length >> 1];
          valid[bi] = 1;
          filledAny = true;
        }
      }
    }
    if (!filledAny) break;
  }

  // 仍无效的块给全局中位频率兜底
  const known: number[] = [];
  for (let i = 0; i < freq.length; i++) if (valid[i]) known.push(freq[i]);
  if (known.length > 0) {
    known.sort((a, b) => a - b);
    const fallback = known[known.length >> 1];
    for (let i = 0; i < freq.length; i++) {
      if (!valid[i]) freq[i] = fallback;
    }
  } else {
    freq.fill(0.12);
  }

  return { cols, rows, blockSize: p.blockSize, freq, valid, width: input.width, height: input.height };
}

/** 一维投影波形的平均峰间距;波形质量太差返回 0 */
function peakSpacing(profile: number[]): number {
  const n = profile.length;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  const gaps: number[] = [];
  let lastPeak = -1;
  for (let i = 1; i < n - 1; i++) {
    if (profile[i] > profile[i - 1] && profile[i] >= profile[i + 1] && profile[i] > mean) {
      if (lastPeak >= 0) gaps.push(i - lastPeak);
      lastPeak = i;
    }
  }
  if (gaps.length < 2) return 0;
  gaps.sort((a, b) => a - b);
  // 取中位数,抵抗单个假峰
  return gaps[gaps.length >> 1];
}

export function frequencyAt(ff: FrequencyField, x: number, y: number): number {
  const bx = Math.max(0, Math.min(ff.cols - 1, Math.floor(x / ff.blockSize)));
  const by = Math.max(0, Math.min(ff.rows - 1, Math.floor(y / ff.blockSize)));
  return ff.freq[by * ff.cols + bx];
}
