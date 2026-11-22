import { GrayImage } from './image';
import { forwardFft, inverseFft, type Fft2dBuffer } from './fft';

/**
 * 周期性背景花纹抑制(需求 1)
 *
 * 原理:包装袋/钞票/瓷砖上的印刷花纹、织物纹理在频谱上表现为
 * 离散、成对、高能量的周期峰;而指纹脊线是局部缓变的窄带结构,
 * 其能量在频谱上呈围绕脊频的弥散环带。因此:
 *   1) 在幅度谱上找局部极大峰(排除 DC 邻域);
 *   2) 落入脊线频带的峰只做温和衰减(保护脊线频率不被一起压掉);
 *      带外周期峰做深度陷波;
 *   3) 陷波为平滑高斯锥,避免振铃;IFFT 后加回直流均值。
 */

export interface SpectrumPeak {
  /** FFT 网格坐标(未 fftshift) */
  fx: number;
  fy: number;
  /** 频率(周/像素) */
  freq: number;
  /** 谱能量(对数幅度) */
  power: number;
  /** 是否处于脊线保护频带 */
  inRidgeBand: boolean;
  /** 实际施加的衰减系数 0..1 */
  gain: number;
}

export interface BgSuppressParams {
  /** 峰阈值:相对中位谱能量的倍数(对数域) */
  peakThreshold: number;
  /** 峰之间的最小频率间隔(周/像素) */
  minPeakSeparation: number;
  /** 最多处理多少个峰(含共轭) */
  maxPeaks: number;
  /** 陷波锥半径(周/像素) */
  notchRadius: number;
  /** 脊线频带(周/像素),该带内只做温和衰减 */
  ridgeBandMin: number;
  ridgeBandMax: number;
  /** 脊线频带内的保守衰减系数 */
  ridgeBandGain: number;
  /** 带外陷波的残余系数 */
  deepNotchGain: number;
  /** DC 排除半径(周/像素) */
  dcRadius: number;
}

export const DEFAULT_BG_PARAMS: BgSuppressParams = {
  peakThreshold: 2.6,
  minPeakSeparation: 0.012,
  maxPeaks: 24,
  notchRadius: 0.02,
  ridgeBandMin: 0.06,
  ridgeBandMax: 0.25,
  ridgeBandGain: 0.5,
  deepNotchGain: 0.02,
  dcRadius: 0.015,
};

export interface BgSuppressResult {
  image: GrayImage;
  peaks: SpectrumPeak[];
  /** 被实际修改的频谱点数占比,用于报告 */
  suppressedEnergyFraction: number;
  spectrumLog: Float32Array;
  rows: number;
  cols: number;
}

function shiftedCoord(k: number, n: number): number {
  return k < (n + 1) / 2 ? k : k - n;
}

export function suppressPeriodicBackground(input: GrayImage, raw?: Partial<BgSuppressParams>): BgSuppressResult {
  const p: BgSuppressParams = { ...DEFAULT_BG_PARAMS, ...raw };
  const mean = input.mean();
  const centered = new Float32Array(input.data.length);
  for (let i = 0; i < centered.length; i++) centered[i] = input.data[i] - mean;

  const buf: Fft2dBuffer = forwardFft({ width: input.width, height: input.height, data: centered });
  const { rows, cols, re, im } = buf;

  // 对数幅度谱
  const logMag = new Float32Array(rows * cols);
  for (let i = 0; i < re.length; i++) logMag[i] = Math.log1p(Math.hypot(re[i], im[i]));

  // 阈值用中位数估计,鲁棒于强峰抬升均值
  const sorted = Float32Array.from(logMag).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  const cutoff = median + p.peakThreshold;

  // 局部极大(3x3,含边界行/列,只比较存在的邻域)+ 阈值 + DC 排除
  const candidates: { k: number; fx: number; fy: number; freq: number; power: number }[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const k = y * cols + x;
      const v = logMag[k];
      if (v <= cutoff) continue;
      const fx = shiftedCoord(x, cols) / cols;
      const fy = shiftedCoord(y, rows) / rows;
      const freq = Math.hypot(fx, fy);
      if (freq < p.dcRadius) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= cols) continue;
          if (logMag[ny * cols + nx] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({ k, fx, fy, freq, power: v });
    }
  }

  // 能量从大到小,做最小间隔抑制式挑选
  candidates.sort((a, b) => b.power - a.power);
  const picked: typeof candidates = [];
  for (const c of candidates) {
    if (picked.length >= p.maxPeaks) break;
    if (picked.every((q) => Math.hypot(q.fx - c.fx, q.fy - c.fy) >= p.minPeakSeparation)) {
      picked.push(c);
    }
  }

  const peaks: SpectrumPeak[] = picked.map((c) => {
    const inRidgeBand = c.freq >= p.ridgeBandMin && c.freq <= p.ridgeBandMax;
    return {
      fx: c.fx,
      fy: c.fy,
      freq: c.freq,
      power: c.power,
      inRidgeBand,
      gain: inRidgeBand ? p.ridgeBandGain : p.deepNotchGain,
    };
  });

  // 构造平滑陷波乘子,逐频谱点应用。
  // 以 notchRadius 为高斯 σ,在约 3σ 范围平滑滚降;范围外乘子为 1 不产生振铃。
  const twoR2 = 2 * p.notchRadius * p.notchRadius;
  const threeSigma2 = 9 * p.notchRadius * p.notchRadius;
  let touchedEnergy = 0;
  let totalEnergy = 0;
  for (let y = 0; y < rows; y++) {
    const sy = shiftedCoord(y, rows) / rows;
    for (let x = 0; x < cols; x++) {
      const sx = shiftedCoord(x, cols) / cols;
      let multiplier = 1;
      for (const pk of peaks) {
        const d2 = (sx - pk.fx) * (sx - pk.fx) + (sy - pk.fy) * (sy - pk.fy);
        if (d2 > threeSigma2) continue;
        // 峰心(d=0)乘子=gain(衰减最强),向外平滑回到 1
        const notch = 1 - (1 - pk.gain) * Math.exp(-d2 / twoR2);
        multiplier *= notch;
      }
      const k = y * cols + x;
      if (multiplier < 0.999) {
        re[k] *= multiplier;
        im[k] *= multiplier;
        touchedEnergy += logMag[k];
      }
      totalEnergy += logMag[k];
    }
  }

  const reconstructed = inverseFft(buf);
  const out = new Float32Array(input.width * input.height);
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const v = reconstructed[y * cols + x] + mean;
      out[y * input.width + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  return {
    image: new GrayImage(input.width, input.height, out),
    peaks,
    suppressedEnergyFraction: totalEnergy > 0 ? touchedEnergy / totalEnergy : 0,
    spectrumLog: logMag,
    rows,
    cols,
  };
}
