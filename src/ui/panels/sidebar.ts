import { store } from '../store';
import { modal } from '../modal';

export interface PanelCtx {
  rerender: () => void;
  showToast: (msg: string, isErr?: boolean) => void;
}

/** 左侧:案件 → 物证 → 图像 三级管理 */
export function renderSidebar(root: HTMLElement, ctx: PanelCtx): void {
  const s = store.state;
  root.innerHTML = `
    <div class="section-title">案件管理
      <span style="flex:1"></span>
      <button id="add-case" title="新建案件">＋</button>
    </div>
    <div id="case-list"></div>
    <div class="section-title">物证管理 <span style="flex:1"></span>
      <button id="add-evidence" title="新建物证" ${s.selectedCaseId ? '' : 'disabled'}>＋</button>
    </div>
    <div id="evidence-list"></div>
    <div class="section-title">现场图像 <span style="flex:1"></span>
      <button id="add-image" title="导入图像" ${s.selectedEvidenceId ? '' : 'disabled'}>＋</button>
      <button id="add-synth" title="生成合成测试图" ${s.selectedEvidenceId ? '' : 'disabled'}>⚙</button>
    </div>
    <div id="image-list"></div>`;

  root.querySelector('#add-case')!.addEventListener('click', () => caseModal(ctx));
  root.querySelector('#add-evidence')!.addEventListener('click', () => evidenceModal(ctx));
  root.querySelector('#add-image')!.addEventListener('click', () => importDialog(ctx));
  root.querySelector('#add-synth')!.addEventListener('click', () => synthDialog(ctx));

  const caseList = root.querySelector('#case-list')!;
  if (!s.cases.length) caseList.innerHTML = '<div class="empty">暂无案件,点击 ＋ 新建</div>';
  for (const c of s.cases) {
    const el = document.createElement('div');
    el.className = `entity${s.selectedCaseId === c.id ? ' active' : ''}`;
    el.innerHTML = `<button class="del" title="删除案件">✕</button>
      <div class="name">${esc(c.name)}</div>
      <div class="meta">${esc(c.caseNumber)} · ${esc(c.investigator)}</div>`;
    el.addEventListener('click', () => store.selectCase(c.id));
    el.querySelector('.del')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除案件「${c.name}」及其全部物证与图像?此操作不可恢复。`)) return;
      await store.deleteCase(c.id);
      ctx.showToast('案件已删除');
    });
    caseList.appendChild(el);
  }

  const evList = root.querySelector('#evidence-list')!;
  const evInCase = s.evidences.filter((e) => e.caseId === s.selectedCaseId);
  if (!s.selectedCaseId) evList.innerHTML = '<div class="empty">先选择案件</div>';
  else if (!evInCase.length) evList.innerHTML = '<div class="empty">该案件暂无物证</div>';
  for (const ev of evInCase) {
    const count = s.images.filter((i) => i.evidenceId === ev.id).length;
    const el = document.createElement('div');
    el.className = `entity${s.selectedEvidenceId === ev.id ? ' active' : ''}`;
    el.innerHTML = `<button class="del" title="删除物证">✕</button>
      <div class="name">${esc(ev.name)}</div>
      <div class="meta">${esc(ev.surface)} · 图像 ${count} 张</div>`;
    el.addEventListener('click', () => store.selectEvidence(ev.id));
    el.querySelector('.del')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除物证「${ev.name}」及其全部图像?`)) return;
      await store.deleteEvidence(ev.id);
      ctx.showToast('物证已删除');
    });
    evList.appendChild(el);
  }

  const imgList = root.querySelector('#image-list')!;
  const imgs = s.images.filter((i) => i.evidenceId === s.selectedEvidenceId);
  if (!s.selectedEvidenceId) imgList.innerHTML = '<div class="empty">先选择物证</div>';
  else if (!imgs.length) imgList.innerHTML = '<div class="empty">暂无图像</div>';
  for (const img of imgs) {
    const el = document.createElement('div');
    el.className = `entity${s.selectedImageId === img.id ? ' active' : ''}`;
    el.innerHTML = `<div class="name">${esc(img.fileName)}${img.groundTruth ? ' <span style="color:#facc15">⚙真值</span>' : ''}</div>
      <div class="meta">${img.width}×${img.height} · ${img.dpi}dpi</div>`;
    el.addEventListener('click', () => void store.selectImage(img.id));
    imgList.appendChild(el);
  }
}

function caseModal(ctx: PanelCtx): void {
  modal.open(
    '新建案件',
    `<div class="form-grid">
      <label class="full">案件名称<input id="m-name" type="text" placeholder="如:11·23 入室盗窃案"></label>
      <label>案件编号<input id="m-no" type="text"></label>
      <label>主办侦查员<input id="m-inv" type="text"></label>
      <label class="full">案情描述<textarea id="m-desc" rows="3"></textarea></label>
    </div>`,
    async () => {
      const name = (document.getElementById('m-name') as HTMLInputElement).value.trim();
      if (!name) throw new Error('案件名称必填');
      await store.createCase({
        name,
        caseNumber: (document.getElementById('m-no') as HTMLInputElement).value.trim() || `AJ-${Date.now()}`,
        investigator: (document.getElementById('m-inv') as HTMLInputElement).value.trim(),
        description: (document.getElementById('m-desc') as HTMLTextAreaElement).value.trim(),
      });
      ctx.showToast('案件已创建');
    },
  );
}

function evidenceModal(ctx: PanelCtx): void {
  modal.open(
    '新建物证',
    `<div class="form-grid">
      <label>物证名称<input id="m-name" type="text" placeholder="如:现场包装袋"></label>
      <label>承痕客体<select id="m-surface">
        <option>包装袋</option><option>钞票</option><option>瓷砖</option>
        <option>纸张</option><option>金属</option><option>玻璃</option><option>其他</option>
      </select></label>
      <label>提取时间<input id="m-date" type="date"></label>
      <label class="full">备注<textarea id="m-note" rows="2"></textarea></label>
    </div>`,
    async () => {
      const name = (document.getElementById('m-name') as HTMLInputElement).value.trim();
      if (!name) throw new Error('物证名称必填');
      await store.createEvidence({
        caseId: store.state.selectedCaseId!,
        name,
        surface: (document.getElementById('m-surface') as HTMLSelectElement).value,
        seizedAt: (document.getElementById('m-date') as HTMLInputElement).value || new Date().toISOString().slice(0, 10),
        note: (document.getElementById('m-note') as HTMLTextAreaElement).value.trim(),
      });
      ctx.showToast('物证已创建');
    },
  );
}

function importDialog(ctx: PanelCtx): void {
  modal.open(
    '导入现场指纹照片',
    `<div class="form-grid">
      <label class="full">图像文件<input id="m-file" type="file" accept="image/*"></label>
      <label>采集分辨率(dpi)<input id="m-dpi" type="number" value="1000" min="72" max="4000"></label>
    </div>
    <p class="meta" style="color:#8595ad;margin-top:8px">大图将在 Worker 中处理,界面不会卡顿。</p>`,
    async () => {
      const file = (document.getElementById('m-file') as HTMLInputElement).files?.[0];
      if (!file) throw new Error('请选择文件');
      const dpi = Number((document.getElementById('m-dpi') as HTMLInputElement).value) || 1000;
      await store.importImage(file, dpi);
      ctx.showToast(`已导入 ${file.name}`);
    },
  );
}

function synthDialog(ctx: PanelCtx): void {
  modal.open(
    '生成合成测试图(带真值特征点)',
    `<div class="form-grid">
      <label>纹型<select id="m-model">
        <option value="loop">箕形 loop</option><option value="arch">拱形 arch</option>
        <option value="whorl">斗形 whorl</option></select></label>
      <label>随机种子<input id="m-seed" type="number" value="2026"></label>
      <label>脊间距(px)<input id="m-period" type="number" value="10" min="6" max="16"></label>
      <label>尺寸(px)<input id="m-size" type="number" value="512" min="256" max="1024" step="128"></label>
      <label class="full">背景花纹(多选)
        <select id="m-bg" multiple size="5">
          <option value="fabric" selected>正弦织物纹</option>
          <option value="grid">印刷网格</option>
          <option value="dots">圆点阵列</option>
          <option value="diagonal">斜纹</option>
          <option value="banknote" selected>钞票式波浪纹</option>
        </select></label>
      <label>背景强度 0..1<input id="m-strength" type="number" value="0.9" step="0.1" min="0" max="1"></label>
      <label>噪声 σ<input id="m-noise" type="number" value="7" step="1" min="0" max="30"></label>
      <label class="full"><input id="m-half" type="checkbox"> 半枚指纹(模拟现场残缺)</label>
    </div>`,
    async () => {
      const { synthesize } = await import('../../core/synthesis');
      const bgSel = document.getElementById('m-bg') as HTMLSelectElement;
      const bgs = Array.from(bgSel.selectedOptions).map((o) => o.value) as import('../../core/synthesis').BackgroundKind[];
      if (!bgs.length) throw new Error('至少选择一种背景花纹');
      const size = Number((document.getElementById('m-size') as HTMLInputElement).value);
      const { image, groundTruth } = synthesize({
        width: size,
        height: size,
        seed: Number((document.getElementById('m-seed') as HTMLInputElement).value),
        model: (document.getElementById('m-model') as HTMLSelectElement).value as import('../../core/synthesis').PatternModel,
        ridgePeriod: Number((document.getElementById('m-period') as HTMLInputElement).value),
        backgrounds: bgs,
        backgroundStrength: Number((document.getElementById('m-strength') as HTMLInputElement).value),
        noiseSigma: Number((document.getElementById('m-noise') as HTMLInputElement).value),
        halfPrint: (document.getElementById('m-half') as HTMLInputElement).checked,
        minutiaCount: 12,
      });
      const seed = (document.getElementById('m-seed') as HTMLInputElement).value;
      await store.importSynthetic(image, `synthetic_${seed}_${size}.png`, 1000, groundTruth);
      ctx.showToast(`合成图已生成,真值特征点 ${groundTruth.minutiae.length} 个`);
    },
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
