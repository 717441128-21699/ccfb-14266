import { store, type EditMode } from '../store';
import { DEFAULT_PIPELINE_PARAMS } from '../../core/pipeline-types';
import type { PipelineParams } from '../../core/pipeline-types';
import type { Viewer } from '../viewer';
import type { PanelCtx } from './sidebar';
import { modal } from '../modal';

interface ToolbarCtx extends PanelCtx {
  viewer: Viewer;
  engine: 'webgl2' | 'cpu';
}

const MODES: { key: EditMode; label: string }[] = [
  { key: 'view', label: '浏览' },
  { key: 'add-ending', label: '加端点' },
  { key: 'add-bifurcation', label: '加分叉' },
  { key: 'move', label: '移动' },
  { key: 'delete', label: '删除' },
];

/** 顶部工具条:运行流水线、编辑模式、图层开关、参数与报告 */
export function renderToolbar(root: HTMLElement, ctx: ToolbarCtx): void {
  const s = store.state;
  const hasImage = !!s.selectedImageId;
  root.innerHTML = `
    <button class="primary" id="btn-run" ${hasImage ? '' : 'disabled'}>运行增强流水线</button>
    <button id="btn-params" ${hasImage ? '' : 'disabled'}>算法参数</button>
    <span style="width:1px;height:20px;background:var(--border)"></span>
    <div class="mode-group" id="mode-group">
      ${MODES.map((m) => `<button data-mode="${m.key}" class="${s.editMode === m.key ? 'active' : ''}" ${hasImage ? '' : 'disabled'}>${m.label}</button>`).join('')}
    </div>
    <span style="width:1px;height:20px;background:var(--border)"></span>
    <label style="display:flex;align-items:center;gap:5px;color:var(--muted)">
      <input type="checkbox" id="chk-ori" ${false ? 'checked' : ''}>方向场</label>
    <label style="display:flex;align-items:center;gap:5px;color:var(--muted)">
      <input type="checkbox" id="chk-min" checked>特征点</label>
    <span style="flex:1"></span>
    <button id="btn-report" ${hasImage && s.steps.length > 1 ? '' : 'disabled'}>导出检验报告</button>`;

  root.querySelector('#btn-run')!.addEventListener('click', () => void run(ctx));
  root.querySelector('#btn-params')!.addEventListener('click', () => paramsModal(ctx));
  root.querySelector('#btn-report')!.addEventListener('click', () => void report(ctx));
  root.querySelectorAll<HTMLButtonElement>('#mode-group button').forEach((b) =>
    b.addEventListener('click', () => store.setEditMode(b.dataset.mode as EditMode)),
  );
  (root.querySelector('#chk-ori') as HTMLInputElement).addEventListener('change', (e) =>
    ctx.viewer.setShowOrientation((e.target as HTMLInputElement).checked),
  );
  (root.querySelector('#chk-min') as HTMLInputElement).addEventListener('change', (e) =>
    ctx.viewer.setShowMinutiae((e.target as HTMLInputElement).checked),
  );
}

async function run(ctx: ToolbarCtx): Promise<void> {
  const img = store.selectedImage;
  if (!img) return;
  ctx.showToast(`正在处理 ${img.fileName} …`);
  const t0 = performance.now();
  try {
    // 参数已在 store 中可选覆盖,缺省用默认参数
    const result = await store.runPipeline(store.state.pipelineParams ?? DEFAULT_PIPELINE_PARAMS);
    const wall = performance.now() - t0;
    void result;
    const total = store.state.lastTotalMs ?? result.totalMs;
    const meets = total <= 4000;
    ctx.showToast(
      `完成:9 个阶段,算法耗时 ${total.toFixed(0)} ms,端到端 ${wall.toFixed(0)} ms(需求 4 口径 ≤4000ms:${meets ? '达标' : '超标'})`,
      !meets,
    );
  } catch (e) {
    ctx.showToast(`处理失败:${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function paramsModal(ctx: PanelCtx): void {
  const current = store.state.pipelineParams ?? DEFAULT_PIPELINE_PARAMS;
  const p: PipelineParams = structuredClone(current);
  modalParams(p, async () => {
    store.state.pipelineParams = p;
    ctx.showToast('参数已保存(下次运行生效,并原样写入留痕)');
  });
}

function modalParams(p: PipelineParams, onConfirm: () => void): void {
  modal.open(
      '算法参数(留痕可回溯)',
      `<div class="form-grid">
        <label>去噪 σ<input id="p-denoise" type="number" step="0.1" value="${p.denoiseSigma}"></label>
        <label>陷波半径(周/像素)<input id="p-notch" type="number" step="0.002" value="${p.background.notchRadius}"></label>
        <label>带内保护增益<input id="p-rgain" type="number" step="0.05" value="${p.background.ridgeBandGain}"></label>
        <label>带外陷波增益<input id="p-dgain" type="number" step="0.01" value="${p.background.deepNotchGain}"></label>
        <label>方向块大小(px)<input id="p-block" type="number" step="4" value="${p.orientation.blockSize}"></label>
        <label>频率下限(周/像素)<input id="p-fmin" type="number" step="0.01" value="${p.frequency.minFreq}"></label>
        <label>频率上限(周/像素)<input id="p-fmax" type="number" step="0.01" value="${p.frequency.maxFreq}"></label>
        <label>Gabor σx 系数<input id="p-sx" type="number" step="0.05" value="${p.gabor.sigmaXFactor}"></label>
        <label>Gabor σy 系数<input id="p-sy" type="number" step="0.05" value="${p.gabor.sigmaYFactor}"></label>
        <label>相干性门控<input id="p-gate" type="number" step="0.01" value="${p.gabor.coherenceGate}"></label>
        <label>二值化半径<input id="p-brad" type="number" step="1" value="${p.binarize.radius}"></label>
        <label>二值化系数<input id="p-bfac" type="number" step="0.05" value="${p.binarize.factor}"></label>
        <label>特征点边界(px)<input id="p-margin" type="number" step="1" value="${p.minutia.borderMargin}"></label>
        <label>毛刺长度(px)<input id="p-spur" type="number" step="1" value="${p.minutia.spurLength}"></label>
      </div>
      <div class="actions" style="margin-top:10px"><button id="p-reset">恢复默认</button></div>`,
      async () => {
        p.denoiseSigma = num('#p-denoise');
        p.background.notchRadius = num('#p-notch');
        p.background.ridgeBandGain = num('#p-rgain');
        p.background.deepNotchGain = num('#p-dgain');
        p.orientation.blockSize = num('#p-block');
        p.frequency.minFreq = num('#p-fmin');
        p.frequency.maxFreq = num('#p-fmax');
        p.gabor.sigmaXFactor = num('#p-sx');
        p.gabor.sigmaYFactor = num('#p-sy');
        p.gabor.coherenceGate = num('#p-gate');
        p.binarize.radius = num('#p-brad');
        p.binarize.factor = num('#p-bfac');
        p.minutia.borderMargin = num('#p-margin');
        p.minutia.spurLength = num('#p-spur');
        onConfirm();
      },
    );
    document.getElementById('p-reset')!.addEventListener('click', () => {
      const d = DEFAULT_PIPELINE_PARAMS;
      const set = (id: string, v: number) => ((document.getElementById(id) as HTMLInputElement).value = String(v));
      set('#p-denoise', d.denoiseSigma);
      set('#p-notch', d.background.notchRadius);
      set('#p-rgain', d.background.ridgeBandGain);
      set('#p-dgain', d.background.deepNotchGain);
      set('#p-block', d.orientation.blockSize);
      set('#p-fmin', d.frequency.minFreq);
      set('#p-fmax', d.frequency.maxFreq);
      set('#p-sx', d.gabor.sigmaXFactor);
      set('#p-sy', d.gabor.sigmaYFactor);
      set('#p-gate', d.gabor.coherenceGate);
      set('#p-brad', d.binarize.radius);
      set('#p-bfac', d.binarize.factor);
      set('#p-margin', d.minutia.borderMargin);
      set('#p-spur', d.minutia.spurLength);
    });
}

function num(sel: string): number {
  return Number((document.querySelector(sel) as HTMLInputElement).value);
}

async function report(ctx: ToolbarCtx): Promise<void> {
  const { buildReportHtml } = await import('../../report/report');
  const s = store.state;
  const img = store.selectedImage!;
  const evidence = s.evidences.find((e) => e.id === img.evidenceId)!;
  const caseRec = s.cases.find((c) => c.id === evidence.caseId)!;
  const html = buildReportHtml({
    case: caseRec,
    evidence,
    image: img,
    steps: s.steps,
    changes: s.changes,
    metrics: s.lastMetrics ?? undefined,
    operator: s.operator,
    generatedAt: Date.now(),
  });
  const win = window.open('', '_blank');
  if (!win) {
    ctx.showToast('浏览器拦截了报告窗口,请允许弹出窗口', true);
    return;
  }
  win.document.write(html);
  win.document.close();
}
