import { GrayImage } from './image';
import type { Minutia } from '../types';
import { uid, normAnglePi } from './util';
import { orientationAt, type OrientationField } from './orientation';

/**
 * 细节特征点自动提取(需求 3)
 * 在单像素骨架上用 crossing number(CN)判定:
 *   CN=1 → 端点(ending);CN=3 → 分叉点(bifurcation)。
 * 后处理:边界距离过滤、近邻重复合并、短毛刺端点删除。
 * 方向取该点局部脊线方向场,保证坐标为亚像素前的整数像素位置,
 * 与真值对比时误差以像素计可直接核验(需求 3 的 ≤3px)。
 */
export interface MinutiaDetectParams {
  /** 距离图像边界的最小像素数 */
  borderMargin: number;
  /** 同类点合并距离 */
  mergeDistance: number;
  /** 短毛刺判定长度(像素),该长度内的端点删除 */
  spurLength: number;
}

export const DEFAULT_MINUTIA_PARAMS: MinutiaDetectParams = {
  borderMargin: 10,
  mergeDistance: 6,
  spurLength: 9,
};

// 8 邻域顺序:p2..p9(顺时针)
const NB8 = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

export function detectMinutiae(
  skeleton: GrayImage,
  of: OrientationField,
  imageId: string,
  raw?: Partial<MinutiaDetectParams>,
): Minutia[] {
  const p = { ...DEFAULT_MINUTIA_PARAMS, ...raw };
  const { width: w, height: h, data } = skeleton;
  const fg = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x] < 128 ? 1 : 0);

  const raw2: Minutia[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!fg(x, y)) continue;
      let cn = 0;
      const vals: number[] = [];
      for (const [dx, dy] of NB8) {
        const v = fg(x + dx, y + dy);
        vals.push(v);
      }
      for (let k = 0; k < 8; k++) cn += Math.abs(vals[(k + 1) % 8] - vals[k]);
      cn /= 2;
      if (cn !== 1 && cn !== 3) continue;
      if (x < p.borderMargin || y < p.borderMargin || x >= w - p.borderMargin || y >= h - p.borderMargin) continue;
      const angle = normAnglePi(orientationAt(of, x, y));
      raw2.push({
        id: uid('m'),
        imageId,
        type: cn === 1 ? 'ending' : 'bifurcation',
        x,
        y,
        angle,
        source: 'auto',
        confidence: cn === 1 ? 0.9 : 0.82,
      });
    }
  }

  // 短毛刺端点:沿骨架走 spurLength 步内遇到分叉点则删除该端点
  const endings = raw2.filter((m) => m.type === 'ending');
  const bifurcations = raw2.filter((m) => m.type === 'bifurcation');
  const bifurSet = new Set(bifurcations.map((m) => m.y * w + m.x));
  const keptEndings = endings.filter((m) => !isSpur(m, fg, w, h, p.spurLength, bifurSet));

  // 邻近"端点-分叉对":同一条毛刺的两端或桥接伪影,成对删除
  const { endings: kept2, bifurcations: keptBif } = removeOppositePairs(keptEndings, bifurcations, p.spurLength);

  const merged = mergeNearby([...kept2, ...keptBif], p.mergeDistance);
  return merged;
}

/** 删除距离过近的端点/分叉异类对(细化毛刺与小桥的典型伪影) */
function removeOppositePairs(endings: Minutia[], bifurcations: Minutia[], maxDist: number) {
  const removedE = new Set<string>();
  const removedB = new Set<string>();
  for (const e of endings) {
    let best: Minutia | null = null;
    let bestD = maxDist;
    for (const b of bifurcations) {
      if (removedB.has(b.id)) continue;
      const d = Math.hypot(e.x - b.x, e.y - b.y);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) {
      removedE.add(e.id);
      removedB.add(best.id);
    }
  }
  return {
    endings: endings.filter((m) => !removedE.has(m.id)),
    bifurcations: bifurcations.filter((m) => !removedB.has(m.id)),
  };
}

function isSpur(
  ending: Minutia,
  fg: (x: number, y: number) => number,
  w: number,
  h: number,
  spurLength: number,
  bifurSet: Set<number>,
): boolean {
  let x = ending.x;
  let y = ending.y;
  let px = -1;
  let py = -1;
  for (let step = 0; step < spurLength; step++) {
    let next: [number, number] | null = null;
    let count = 0;
    for (const [dx, dy] of NB8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!fg(nx, ny) || (nx === px && ny === py)) continue;
      count++;
      if (!next) next = [nx, ny];
    }
    if (count > 1 && bifurSet.has(y * w + x) && step > 0) return true;
    if (!next) return false;
    px = x;
    py = y;
    [x, y] = next;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
  }
  return false;
}

/** 同类近邻点合并为质心(平均坐标,四舍五入保持整数像素) */
function mergeNearby(list: Minutia[], distance: number): Minutia[] {
  const used = new Array(list.length).fill(false);
  const out: Minutia[] = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const cluster: Minutia[] = [list[i]];
    used[i] = true;
    for (let j = i + 1; j < list.length; j++) {
      if (used[j] || list[j].type !== list[i].type) continue;
      const d2 = (list[j].x - list[i].x) ** 2 + (list[j].y - list[i].y) ** 2;
      if (d2 <= distance * distance) {
        cluster.push(list[j]);
        used[j] = true;
      }
    }
    if (cluster.length === 1) {
      out.push(cluster[0]);
    } else {
      const ax = Math.round(cluster.reduce((a, m) => a + m.x, 0) / cluster.length);
      const ay = Math.round(cluster.reduce((a, m) => a + m.y, 0) / cluster.length);
      const base = cluster[0];
      out.push({ ...base, id: uid('m'), x: ax, y: ay });
    }
  }
  return out;
}
