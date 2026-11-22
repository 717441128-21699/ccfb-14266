import './styles.css';
import { store } from './store';
import { Viewer } from './viewer';
import { renderSidebar } from './panels/sidebar';
import { renderRightPanel } from './panels/rightPanel';
import { renderToolbar } from './panels/toolbar';
import { GlEngine } from '../gl/engine';
import { storage } from '../core/storage';

async function detectEngine(): Promise<'webgl2' | 'cpu'> {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl && gl.getExtension('EXT_color_buffer_float')) {
      // 触发一次完整初始化以确认可用
      new GlEngine(c).dispose();
      return 'webgl2';
    }
  } catch {
    /* fallthrough */
  }
  return 'cpu';
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="topbar">
      <h1>潜在指纹图像增强工作台</h1>
      <span class="sub">FFT 背景抑制 · 方向/频率场 · Gabor 增强 · 全程留痕</span>
      <span class="spacer"></span>
      <span id="engine-badge" class="engine-badge">引擎检测中…</span>
    </header>
    <div class="layout">
      <aside class="sidebar" id="sidebar"></aside>
      <div class="main">
        <div class="toolbar" id="toolbar"></div>
        <div class="viewer" id="viewer"></div>
        <div class="legend"><span class="e">端点</span><span class="b">分叉点</span><span>黄圈=人工编辑</span></div>
      </div>
      <aside class="sidebar right" id="right-panel"></aside>
    </div>
    <div id="modal-root"></div>
    <div id="toast-root"></div>`;

  const engine = await detectEngine();
  const badge = document.getElementById('engine-badge')!;
  badge.textContent = engine === 'webgl2' ? 'WebGL2 引擎可用' : 'CPU 引擎(WebGL2 不可用)';
  badge.classList.toggle('cpu', engine === 'cpu');

  const viewer = new Viewer(document.getElementById('viewer')!);

  // 选中图像或回溯步骤变化时,自动加载对应快照
  let lastShownKey = '';
  const syncViewer = async (): Promise<void> => {
    const s = store.state;
    const step = s.steps[s.activeStepIndex];
    const key = step?.snapshotKey ?? store.selectedImage?.originalKey ?? '';
    if (!key || key === lastShownKey) return;
    lastShownKey = key;
    try {
      const blob = await storage.getBlob(key);
      if (blob) await viewer.showBlob(blob);
    } catch {
      /* 快照缺失时保留当前画面 */
    }
  };

  const rerender = (): void => {
    renderSidebar(document.getElementById('sidebar')!, { rerender, showToast });
    renderToolbar(document.getElementById('toolbar')!, { rerender, showToast, viewer, engine });
    renderRightPanel(document.getElementById('right-panel')!, { rerender, showToast, viewer });
    void syncViewer();
  };
  store.subscribe(rerender);
  await store.init();
  rerender();

  function showToast(msg: string, isErr = false): void {
    const root = document.getElementById('toast-root')!;
    const el = document.createElement('div');
    el.className = `toast${isErr ? ' err' : ''}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}

main().catch((e) => {
  document.getElementById('app')!.innerHTML = `<div class="empty">启动失败:${String(e)}</div>`;
});
