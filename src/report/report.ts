import type { CaseRecord, Evidence, FpImage, MinutiaChange, ProcessingStep, STEP_LABELS } from '../types';
import { STEP_LABELS as LABELS } from '../types';
import type { MinutiaMetrics } from '../core/metrics';

/**
 * 检验报告生成:每个处理步骤的参数逐项打印,附特征点清单、
 * 人工改动留痕与合成图的真值评估。产出自包含 HTML(可直接打印/存盘)。
 */
export interface ReportData {
  case: CaseRecord;
  evidence: Evidence;
  image: FpImage;
  steps: ProcessingStep[];
  changes: MinutiaChange[];
  metrics?: MinutiaMetrics;
  operator: string;
  generatedAt: number;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function fmtParams(params: Record<string, number | string | boolean>): string {
  const keys = Object.keys(params);
  if (!keys.length) return '<span class="muted">—</span>';
  return keys
    .map((k) => `<tr><td class="pk">${esc(k)}</td><td>${esc(String(params[k]))}</td></tr>`)
    .join('');
}

export function buildReportHtml(d: ReportData): string {
  const stepRows = d.steps
    .map(
      (s, i) => `
    <section class="step">
      <h3>${i + 1}. ${LABELS[s.kind]} <span class="muted">(${s.kind})</span></h3>
      <p class="meta">时间:${new Date(s.createdAt).toLocaleString('zh-CN')} ｜ 耗时:${s.durationMs.toFixed(1)} ms${
        s.note ? ` ｜ 备注:${esc(s.note)}` : ''
      }</p>
      <table class="params"><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>${fmtParams(s.params)}</tbody></table>
      ${
        Object.keys(s.metrics).length
          ? `<table class="params"><thead><tr><th>度量</th><th>值</th></tr></thead><tbody>${fmtParams(
              Object.fromEntries(Object.entries(s.metrics).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])),
            )}</tbody></table>`
          : ''
      }
    </section>`,
    )
    .join('');

  const changeRows = d.changes.length
    ? d.changes
        .map(
          (c) => `<tr>
        <td>${new Date(c.at).toLocaleString('zh-CN')}</td>
        <td>${esc(c.operator)}</td>
        <td>${esc(c.minutiaId)}</td>
        <td>${actionLabel(c.action)}</td>
        <td>${c.before ? esc(JSON.stringify(c.before)) : '—'}</td>
        <td>${c.after ? esc(JSON.stringify(c.after)) : '—'}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">无人工改动</td></tr>';

  const metricsBlock = d.metrics
    ? `<section class="step"><h3>真值评估(合成图)</h3>
      <table class="params"><tbody>
      <tr><td class="pk">命中 / 误检 / 漏检</td><td>${d.metrics.truePositives} / ${d.metrics.falsePositives} / ${d.metrics.falseNegatives}</td></tr>
      <tr><td class="pk">精确率 / 召回率</td><td>${(d.metrics.precision * 100).toFixed(1)}% / ${(d.metrics.recall * 100).toFixed(1)}%</td></tr>
      <tr><td class="pk">平均位置误差</td><td>${d.metrics.meanLocationError.toFixed(2)} px(最大 ${d.metrics.maxLocationError.toFixed(2)} px)</td></tr>
      <tr><td class="pk">≤3px 命中率</td><td>${(d.metrics.within3pxRate * 100).toFixed(1)}%</td></tr>
      <tr><td class="pk">平均方向误差</td><td>${d.metrics.meanAngleErrorDeg.toFixed(1)}°</td></tr>
      </tbody></table></section>`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>指纹增强检验报告 - ${esc(d.image.fileName)}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 32px; color: #1a2330; font-size: 13px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; border-left: 4px solid #2563eb; padding-left: 8px; margin-top: 28px; }
  h3 { font-size: 14px; margin: 14px 0 6px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 14px; }
  th, td { border: 1px solid #b8c2d0; padding: 5px 8px; text-align: left; }
  th { background: #eef2f7; }
  .pk { color: #475569; width: 240px; }
  .muted { color: #8a94a6; }
  .meta { color: #64748b; margin: 2px 0; }
  .step { break-inside: avoid; border: 1px solid #dde3ec; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
  .head td { width: 25%; }
  @media print { body { margin: 12px; } .step { border-color: #999; } }
</style></head><body>
<h1>潜在指纹图像增强检验报告</h1>
<table class="head"><tbody>
  <tr><td class="pk">案件名称/编号</td><td>${esc(d.case.name)} / ${esc(d.case.caseNumber)}</td>
      <td class="pk">物证</td><td>${esc(d.evidence.name)}(${esc(d.evidence.surface)})</td></tr>
  <tr><td class="pk">图像文件</td><td>${esc(d.image.fileName)}</td>
      <td class="pk">分辨率/尺寸</td><td>${d.image.dpi} dpi / ${d.image.width}×${d.image.height} px</td></tr>
  <tr><td class="pk">鉴定人</td><td>${esc(d.operator)}</td>
      <td class="pk">报告生成时间</td><td>${new Date(d.generatedAt).toLocaleString('zh-CN')}</td></tr>
</tbody></table>
<h2>一、处理步骤与参数(全程留痕)</h2>
${stepRows}
${metricsBlock}
<h2>二、特征点人工改动记录</h2>
<table><thead><tr><th>时间</th><th>操作人</th><th>特征点 ID</th><th>动作</th><th>改动前</th><th>改动后</th></tr></thead>
<tbody>${changeRows}</tbody></table>
<p class="muted">本报告由潜在指纹图像增强工作台自动生成,所有处理参数与人工改动均来自系统留痕,不可篡改。</p>
</body></html>`;
}

function actionLabel(a: MinutiaChange['action']): string {
  return { add: '新增', move: '移动', retype: '改类型', delete: '删除' }[a];
}

export type { STEP_LABELS };
