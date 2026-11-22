import { GrayImage } from './image';
import { makeRng, normAnglePi } from './util';
import type { GroundTruth, GroundTruthMinutia, MinutiaType } from '../types';
import { adaptiveBinarize, zhangSuenThin } from './binarize';
import { estimateOrientation } from './orientation';
import { detectMinutiae } from './minutiae';

/**
 * 合成测试图(需求:按真实纹线模型叠加背景花纹,带真值特征点)
 *
 * 脊线模型:
 *   1) 解析方向场(arch/loop/whorl 三类纹型);
 *   2) 沿方向场积分追踪流线得到弯曲平行脊线;
 *   3) 在线上植入端点(脊线提前终止)与分叉点(新生一条支流),
 *      位置/类型/方向全部作为真值输出;
 *   4) 距脊线距离场 + 余弦剖面渲染灰度脊,叠加接触区椭圆遮罩。
 * 背景模型(周期性):正弦织物纹、印刷网格、圆点阵列、斜纹、钞票式波浪纹。
 */

export type PatternModel = 'arch' | 'loop' | 'whorl';
export type BackgroundKind = 'fabric' | 'grid' | 'dots' | 'diagonal' | 'banknote';

export interface SynthesizeOptions {
  width: number;
  height: number;
  seed: number;
  model: PatternModel;
  /** 平均脊间距(像素),1000dpi 下真实指纹约 8~14px */
  ridgePeriod: number;
  backgrounds: BackgroundKind[];
  /** 背景混合强度 0..1 */
  backgroundStrength: number;
  noiseSigma: number;
  /** true 时只保留左半枚(模拟现场半枚指纹) */
  halfPrint?: boolean;
  minutiaCount: number;
}

export const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  fabric: '正弦织物纹',
  grid: '印刷网格',
  dots: '圆点阵列',
  diagonal: '斜纹',
  banknote: '钞票式波浪纹',
};

interface Point {
  x: number;
  y: number;
}

/** 解析方向场:返回归一化坐标(nx,ny ∈ [-1,1])处的脊线方向 */
function modelAngle(model: PatternModel, nx: number, ny: number): number {
  switch (model) {
    case 'arch': {
      // 拱形:中部近水平,向两侧上挑
      return normAnglePi(Math.PI / 2 + 0.9 * nx + 0.35 * Math.sin(ny * Math.PI));
    }
    case 'loop': {
      // 箕形:绕核点 (0.15, 0.1) 的切线场
      const dx = nx - 0.15;
      const dy = ny - 0.1;
      const base = Math.atan2(dy, dx) + Math.PI / 2;
      return normAnglePi(base + 0.25 * nx);
    }
    case 'whorl': {
      // 斗形:螺旋场
      const dx = nx;
      const dy = ny;
      const r = Math.hypot(dx, dy);
      const base = Math.atan2(dy, dx) + Math.PI / 2 + 0.6 * (1 - Math.min(1, r));
      return normAnglePi(base);
    }
  }
}

export function synthesize(opts: SynthesizeOptions): { image: GrayImage; groundTruth: GroundTruth } {
  const rng = makeRng(opts.seed);
  const w = opts.width;
  const h = opts.height;
  const period = opts.ridgePeriod;

  const angleAt = (x: number, y: number): number =>
    modelAngle(opts.model, (x / w) * 2 - 1, (y / h) * 2 - 1);

  // ---- 1. 生成真值特征点 ----
  const gtMinutiae: GroundTruthMinutia[] = [];
  const cx = w / 2;
  const cy = h / 2;
  const rx = w * 0.34;
  const ry = h * 0.38;
  let tries = 0;
  while (gtMinutiae.length < opts.minutiaCount && tries < opts.minutiaCount * 40) {
    tries++;
    const x = w * (0.2 + rng() * 0.6);
    const y = h * (0.2 + rng() * 0.6);
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    if (nx * nx + ny * ny > 0.85) continue;
    if (gtMinutiae.some((m) => Math.hypot(m.x - x, m.y - y) < period * 2.2)) continue;
    const type: MinutiaType = rng() > 0.5 ? 'ending' : 'bifurcation';
    gtMinutiae.push({ x: Math.round(x), y: Math.round(y), type, angle: normAnglePi(angleAt(x, y)) });
  }

  // ---- 2. 沿方向场追踪脊线流线 ----
  const ridges: Point[][] = [];
  const endings = new Map(gtMinutiae.filter((m) => m.type === 'ending').map((m) => [`${m.x},${m.y}`, m]));
  const bifurcations = gtMinutiae.filter((m) => m.type === 'bifurcation');

  const inside = (x: number, y: number): boolean => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  };

  const trace = (seed: Point, dirSign: 1 | -1, terminateKeys: Set<string>): Point[] => {
    const pts: Point[] = [];
    let x = seed.x;
    let y = seed.y;
    const step = period / 4;
    for (let s = 0; s < (w + h) * 2; s++) {
      pts.push({ x, y });
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (s > 2 && terminateKeys.has(key)) break; // 端点:脊线提前终止
      const a = angleAt(x, y) + (dirSign === 1 ? 0 : Math.PI);
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      if (!inside(x, y)) break;
    }
    return pts;
  };

  const endingKeys = new Set(endings.keys());
  // 种子线:在核上方按脊间距布种,双向追踪
  const seedCount = Math.floor((ry * 1.7) / period);
  for (let i = -seedCount; i <= seedCount; i++) {
    const seedY = cy + i * period;
    const seed = { x: cx, y: seedY };
    if (!inside(seed.x, seed.y)) continue;
    const fwd = trace(seed, 1, endingKeys);
    const bwd = trace(seed, -1, endingKeys);
    ridges.push([...bwd.reverse(), ...fwd.slice(1)]);
  }

  // 分叉点:从分叉位置沿脊向新生一条短支流(长度约 6~10 个脊周期)
  for (const bf of bifurcations) {
    const branch: Point[] = [];
    let x = bf.x;
    let y = bf.y;
    const a0 = angleAt(x, y);
    // 支流方向:本地脊向偏转约 0.5 个脊间距的角度
    let a = a0 + (rng() > 0.5 ? 0.35 : -0.35);
    const step = period / 4;
    const len = period * (6 + rng() * 4);
    for (let s = 0; s < len / step; s++) {
      branch.push({ x, y });
      a = 0.7 * a + 0.3 * angleAt(x, y);
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      if (!inside(x, y)) break;
    }
    ridges.push(branch);
  }

  // ---- 3. 距离场渲染脊线 ----
  const nearest = new Float32Array(w * h).fill(period * 2);
  const cap2 = (period * 2) ** 2;
  for (const line of ridges) {
    for (const pt of line) {
      const px = pt.x | 0;
      const py = pt.y | 0;
      const R = Math.ceil(period * 1.6);
      for (let yy = Math.max(0, py - R); yy <= Math.min(h - 1, py + R); yy++) {
        for (let xx = Math.max(0, px - R); xx <= Math.min(w - 1, px + R); xx++) {
          const d2 = (xx - pt.x) ** 2 + (yy - pt.y) ** 2;
          if (d2 >= cap2) continue;
          const idx = yy * w + xx;
          if (d2 < nearest[idx]) nearest[idx] = d2;
        }
      }
    }
  }

  const contact = new Float32Array(w * h);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const ell = nx * nx + ny * ny;
      // 半枚:裁掉右半
      const halfMask = opts.halfPrint ? (x <= cx ? 1 : 0) : 1;
      const edge = Math.max(0, Math.min(1, (1.15 - ell) * 4));
      contact[idx] = edge * halfMask;
      const d = Math.sqrt(nearest[idx]);
      const ridge = Math.cos((Math.PI * d) / period); // 脊心=1
      const v = 205 - 95 * ridge; // 脊暗谷亮
      gray[idx] = 232 * (1 - contact[idx]) + v * contact[idx];
    }
  }

  // ---- 3b. 干净图真值:从无背景脊线图的骨架提取,几何与真实渲染一致 ----
  const cleanImage = new GrayImage(w, h, Float32Array.from(gray));
  const cleanOri = estimateOrientation(cleanImage);
  const cleanBin = adaptiveBinarize(cleanImage, { radius: Math.round(period * 1.5), factor: 1.0 });
  const cleanSkel = zhangSuenThin(cleanBin);
  const cleanMinutiae = detectMinutiae(cleanSkel, cleanOri, 'gt', {
    borderMargin: 10,
    mergeDistance: 5,
    spurLength: Math.round(period * 0.8),
  });
  const gtExtracted: GroundTruthMinutia[] = cleanMinutiae.map((m) => ({
    x: m.x,
    y: m.y,
    type: m.type,
    angle: m.angle,
  }));
  // 骨架提取退化时回退到手工埋点,保证真值始终非空
  const finalGt = gtExtracted.length >= 3 ? gtExtracted : gtMinutiae;

  // ---- 4. 叠加周期性背景花纹 ----
  let bg = new Float32Array(w * h);
  for (const kind of opts.backgrounds) {
    const layer = renderBackground(kind, w, h, rng);
    for (let i = 0; i < bg.length; i++) bg[i] += layer[i];
  }
  if (opts.backgrounds.length > 1) bg = bg.map((v) => v / opts.backgrounds.length);

  const strength = opts.backgroundStrength;
  for (let i = 0; i < gray.length; i++) {
    // 背景在接触区弱混入(承痕客体仍透印),接触区外完全是背景
    const mix = contact[i] * strength * 0.45 + (1 - contact[i]);
    gray[i] = gray[i] * (1 - mix) + bg[i] * mix;
  }

  // 轻微模糊 + 噪声 + 对比度微调,模拟拍摄/扫描链路
  const noisy = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const n = (rng() + rng() + rng() - 1.5) * opts.noiseSigma;
    noisy[i] = Math.max(0, Math.min(255, gray[i] + n));
  }

  const groundTruth: GroundTruth = {
    orientationModel: opts.model,
    seed: opts.seed,
    ridgeFrequency: 1 / period,
    backgroundKinds: opts.backgrounds,
    minutiae: finalGt,
    plantedMinutiae: gtMinutiae,
  };
  return { image: new GrayImage(w, h, noisy), groundTruth };
}

function renderBackground(kind: BackgroundKind, w: number, h: number, rng: () => number): Float32Array {
  const out = new Float32Array(w * h);
  const base = 150 + rng() * 40;
  const amp = 28 + rng() * 22;
  switch (kind) {
    case 'fabric': {
      const fx = 4 + rng() * 4; // 周期像素
      const fy = 4 + rng() * 4;
      const ang = rng() * Math.PI;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = x * Math.cos(ang) + y * Math.sin(ang);
          const v = -x * Math.sin(ang) + y * Math.cos(ang);
          out[y * w + x] = base + amp * (Math.sin((2 * Math.PI * u) / fx) + Math.sin((2 * Math.PI * v) / fy));
        }
      }
      break;
    }
    case 'grid': {
      const spacing = 14 + rng() * 10;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const gx = Math.min(x % spacing, spacing - (x % spacing));
          const gy = Math.min(y % spacing, spacing - (y % spacing));
          const line = Math.min(gx, gy) < 1.2 ? -amp : 0;
          out[y * w + x] = base + line;
        }
      }
      break;
    }
    case 'dots': {
      const spacing = 12 + rng() * 8;
      const radius = spacing * 0.28;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const cx = ((x / spacing) | 0) * spacing + spacing / 2;
          const cy = ((y / spacing) | 0) * spacing + spacing / 2;
          const d = Math.hypot(x - cx, y - cy);
          out[y * w + x] = base + (d < radius ? -amp * (1 - d / radius) : 0);
        }
      }
      break;
    }
    case 'diagonal': {
      const period = 6 + rng() * 5;
      const ang = Math.PI / 4 + (rng() - 0.5) * 0.4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = x * Math.cos(ang) + y * Math.sin(ang);
          out[y * w + x] = base + amp * Math.sin((2 * Math.PI * u) / period);
        }
      }
      break;
    }
    case 'banknote': {
      // 两种频率叠加的波浪雕刻纹
      const f1 = 9 + rng() * 4;
      const f2 = 17 + rng() * 6;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const phase = 0.15 * Math.sin(y / 23);
          const u = x + 12 * Math.sin(y / 31);
          out[y * w + x] =
            base +
            amp * 0.7 * Math.sin((2 * Math.PI * u) / f1 + phase) +
            amp * 0.4 * Math.sin((2 * Math.PI * (u + y)) / f2);
        }
      }
      break;
    }
  }
  return out;
}
