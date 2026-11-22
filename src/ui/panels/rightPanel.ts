import { store, STEP_LABELS } from '../store';
import type { Minutia } from '../../types';
import type { Viewer } from '../viewer';
import type { PanelCtx } from './sidebar';

/** 右侧:处理步骤留痕、特征点清单与改动记录、真值评估 */
export function renderRightPanel(root: HTMLElement, ctx: PanelCtx & { viewer: Viewer }): void {
  const s = store.state;
  root.innerHTML = `
    <div class="section-title">处理步骤(点击回溯快照)</div>
    <div id="step-list"></div>
    <div class="section-title">性能与评估</div>
    <div id="metrics"></div>
    <div class="section-title">特征点清单 <span style="flex:1"></span>
      <span style="color:var(--muted);font-weight:400">双击画布改类型</span>
    </div>
    <div class="scroll-list" id="minutia-list"></div>
    <div class="section-title">人工改动留痕(不可删除)</div>
    <div class="scroll-list" id="change-list"></div>`;

  // ---- 步骤 ----
  const stepList = root.querySelector('#step-list')!;
  if (!s.steps.length) stepList.innerHTML = '<div class="empty">导入图像后可运行流水线</div>';
  s.steps.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = `step-item${i === s.activeStepIndex ? ' active' : ''}`;
    const paramStr = Object.entries(step.params)
      .slice(0, 3)
      .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v" title="${String(v)}">${String(v)}</span></div>`)
      .join('');
    el.innerHTML = `<div class="head">
        <span>${step.order}. ${STEP_LABELS[step.kind]}</span>
        <span class="ms">${step.durationMs.toFixed(1)}ms</span>
      </div>${paramStr}`;
    el.addEventListener('click', () => void activateStep(i, ctx));
    stepList.appendChild(el);
  });

  // ---- 性能/评估 ----
  const metrics = root.querySelector('#metrics')!;
  const totalMs = s.lastTotalMs;
  const m = s.lastMetrics;
  const img = store.selectedImage;
  metrics.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${totalMs != null ? totalMs.toFixed(0) : '—'}</div><div class="lbl">算法总耗时 ms</div></div>
      <div class="stat"><div class="num ${totalMs != null && totalMs <= 4000 ? 'metric-good' : 'metric-bad'}">${
        totalMs != null ? (totalMs <= 4000 ? '达标' : '超标') : '—'
      }</div><div class="lbl">需求 4:≤4000ms</div></div>
      <div class="stat"><div class="num">${s.minutiae.filter((q) => q.type === 'ending').length}</div><div class="lbl">端点</div></div>
      <div class="stat"><div class="num">${s.minutiae.filter((q) => q.type === 'bifurcation').length}</div><div class="lbl">分叉点</div></div>
    </div>
    ${
      m && img?.groundTruth
        ? `<div class="stat-grid" style="margin-top:6px">
      <div class="stat"><div class="num">${(m.precision * 100).toFixed(0)}%</div><div class="lbl">精确率</div></div>
      <div class="stat"><div class="num">${(m.recall * 100).toFixed(0)}%</div><div class="lbl">召回率</div></div>
      <div class="stat"><div class="num ${m.meanLocationError <= 3 ? 'metric-good' : 'metric-bad'}">${m.meanLocationError.toFixed(2)}</div><div class="lbl">平均位置误差 px</div></div>
      <div class="stat"><div class="num ${m.within3pxRate >= 0.6 ? 'metric-good' : 'metric-bad'}">${(m.within3pxRate * 100).toFixed(0)}%</div><div class="lbl">≤3px 命中占比</div></div>
    </div>`
        : '<div class="empty">合成图运行后显示真值评估</div>'
    }`;

  // ---- 特征点清单 ----
  const mList = root.querySelector('#minutia-list')!;
  if (!s.minutiae.length) mList.innerHTML = '<div class="empty">暂无特征点</div>';
  for (const minutia of s.minutiae) {
    const row = document.createElement('div');
    row.className = `minutia-row ${minutia.type}`;
    row.innerHTML = `<span class="dot"></span>
      <span>(${minutia.x}, ${minutia.y}) ${minutia.type === 'ending' ? '端点' : '分叉'}</span>
      <span class="id">${minutia.id} · ${sourceLabel(minutia.source)}</span>
      <button data-act="retype" title="切换类型">改类</button>
      <button data-act="del" class="danger" title="删除">删</button>`;
    row.querySelector('[data-act="retype"]')!.addEventListener('click', () => void store.retypeMinutia(minutia.id));
    row.querySelector('[data-act="del"]')!.addEventListener('click', () => void store.deleteMinutia(minutia.id));
    mList.appendChild(row);
  }

  // ---- 改动记录 ----
  const cList = root.querySelector('#change-list')!;
  if (!s.changes.length) cList.innerHTML = '<div class="empty">尚无人工改动</div>';
  else
    cList.innerHTML = s.changes
      .map(
        (c) => `<div class="minutia-row" style="cursor:default">
        <span style="color:var(--muted)">${new Date(c.at).toLocaleTimeString('zh-CN')}</span>
        <span>${actionLabel(c.action)}</span>
        <span class="id">${esc(c.operator)} · ${c.minutiaId.slice(-6)}</span>
      </div>`,
      )
      .join('');
}

async function activateStep(i: number, ctx: PanelCtx & { viewer: Viewer }): Promise<void> {
  store.setActiveStep(i);
  const step = store.state.steps[i];
  try {
    const blob = await store.loadStepBlob(step);
    await ctx.viewer.showBlob(blob);
  } catch (e) {
    ctx.showToast(e instanceof Error ? e.message : String(e), true);
  }
}

function sourceLabel(s: Minutia['source']): string {
  return { auto: '自动', manual: '人工', edited: '已编辑', deleted: '已删除' }[s];
}
function actionLabel(a: string): string {
  return { add: '新增', move: '移动', retype: '改类型', delete: '删除' }[a] ?? a;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
