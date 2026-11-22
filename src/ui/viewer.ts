import { store } from './store';
import type { Minutia } from '../types';
import type { OrientationField } from '../core/orientation';

/**
 * 主画布:展示选定步骤的快照,叠加方向场/特征点,
 * 并把鼠标交互映射为特征点编辑动作(坐标严格取整像素,满足 ≤3px 口径)。
 */
export class Viewer {
  canvas: HTMLCanvasElement;
  private base: HTMLImageElement | null = null;
  private orientation: OrientationField | null = null;
  private showOrientation = false;
  private showMinutiae = true;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage';
    container.appendChild(this.canvas);
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
  }

  setOrientation(of: OrientationField | null): void {
    this.orientation = of;
    this.render();
  }

  setShowOrientation(v: boolean): void {
    this.showOrientation = v;
    this.render();
  }
  setShowMinutiae(v: boolean): void {
    this.showMinutiae = v;
    this.render();
  }

  async showBlob(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    this.base = img;
    URL.revokeObjectURL(url);
    this.render();
  }

  fitScale(maxW: number, maxH: number): number {
    if (!this.base) return 1;
    return Math.min(1, maxW / this.base.naturalWidth, maxH / this.base.naturalHeight);
  }

  private render(): void {
    if (!this.base) return;
    const w = this.base.naturalWidth;
    const h = this.base.naturalHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!;
    ctx.drawImage(this.base, 0, 0, w, h);

    if (this.showOrientation && this.orientation) this.drawOrientation(ctx);
    if (this.showMinutiae) this.drawMinutiae(ctx, store.state.minutiae);
  }

  private drawOrientation(ctx: CanvasRenderingContext2D): void {
    const of = this.orientation!;
    ctx.strokeStyle = 'rgba(96,165,250,0.55)';
    ctx.lineWidth = 1;
    const step = of.blockSize;
    for (let by = 0; by < of.rows; by++) {
      for (let bx = 0; bx < of.cols; bx++) {
        const i = by * of.cols + bx;
        if (of.coherence[i] < 0.25) continue;
        const cx = (bx + 0.5) * step;
        const cy = (by + 0.5) * step;
        const a = of.angles[i];
        const len = step * 0.42;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.stroke();
      }
    }
  }

  private drawMinutiae(ctx: CanvasRenderingContext2D, list: Minutia[]): void {
    for (const m of list) {
      const color = m.type === 'ending' ? '#38bdf8' : '#fb923c';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      if (m.type === 'ending') {
        ctx.beginPath();
        ctx.arc(m.x, m.y, 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 分叉点用三条短线表示
        for (let k = 0; k < 3; k++) {
          const a = m.angle + (k * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(m.x + Math.cos(a) * 6, m.y + Math.sin(a) * 6);
          ctx.stroke();
        }
      }
      if (m.source === 'manual' || m.source === 'edited') {
        ctx.strokeStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(m.x, m.y, 7.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private eventPos(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  private findNear(pos: { x: number; y: number }, radius = 8): Minutia | undefined {
    let best: Minutia | undefined;
    let bestD = radius;
    for (const m of store.state.minutiae) {
      const d = Math.hypot(m.x - pos.x, m.y - pos.y);
      if (d <= bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const pos = this.eventPos(e);
    const mode = store.state.editMode;
    if (mode === 'add-ending') await store.addMinutia(pos.x, pos.y, 'ending');
    else if (mode === 'add-bifurcation') await store.addMinutia(pos.x, pos.y, 'bifurcation');
    else if (mode === 'delete') {
      const m = this.findNear(pos);
      if (m) await store.deleteMinutia(m.id);
    } else if (mode === 'move') {
      const m = this.findNear(pos);
      if (m) await store.moveMinutia(m.id, pos.x, pos.y);
    }
    this.render();
  }

  private async onDoubleClick(e: MouseEvent): Promise<void> {
    const pos = this.eventPos(e);
    const m = this.findNear(pos);
    if (m) await store.retypeMinutia(m.id);
    this.render();
  }

  refresh(): void {
    this.render();
  }
}
