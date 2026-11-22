import { storage, newKey } from '../core/storage';
import { uid, nowTs } from '../core/util';
import type {
  CaseRecord,
  Evidence,
  FpImage,
  Minutia,
  MinutiaChange,
  ProcessingStep,
  StepKind,
  GroundTruth,
} from '../types';
import { STEP_LABELS } from '../types';
import { GrayImage } from '../core/image';
import type { PipelineParams } from '../core/pipeline-types';
import { evaluateMinutiae, type MinutiaMetrics } from '../core/metrics';
import { runPipelineInWorker } from '../workers/client';

export type EditMode = 'view' | 'add-ending' | 'add-bifurcation' | 'move' | 'delete';

interface AppState {
  cases: CaseRecord[];
  evidences: Evidence[];
  images: FpImage[];
  selectedCaseId: string | null;
  selectedEvidenceId: string | null;
  selectedImageId: string | null;
  steps: ProcessingStep[];
  minutiae: Minutia[];
  changes: MinutiaChange[];
  activeStepIndex: number;
  editMode: EditMode;
  operator: string;
  pipelineParams: PipelineParams | null;
  lastMetrics: MinutiaMetrics | null;
  lastTotalMs: number | null;
}

type Listener = () => void;

class Store {
  state: AppState = {
    cases: [],
    evidences: [],
    images: [],
    selectedCaseId: null,
    selectedEvidenceId: null,
    selectedImageId: null,
    steps: [],
    minutiae: [],
    changes: [],
    activeStepIndex: -1,
    editMode: 'view',
    operator: '鉴定人甲',
    pipelineParams: null,
    lastMetrics: null,
    lastTotalMs: null,
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }

  async init(): Promise<void> {
    this.state.cases = await storage.listCases();
    this.state.evidences = await storage.listEvidences();
    this.state.images = await storage.listImages();
    this.emit();
  }

  // ---------- 案件 ----------
  async createCase(data: Omit<CaseRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CaseRecord> {
    const rec: CaseRecord = { ...data, id: uid('case'), createdAt: nowTs(), updatedAt: nowTs() };
    await storage.putCase(rec);
    this.state.cases = await storage.listCases();
    this.selectCase(rec.id);
    this.emit();
    return rec;
  }

  selectCase(id: string | null): void {
    this.state.selectedCaseId = id;
    this.state.selectedEvidenceId = null;
    this.state.selectedImageId = null;
    this.resetImageScope();
    this.emit();
  }

  async deleteCase(id: string): Promise<void> {
    await storage.deleteCase(id);
    this.state.cases = await storage.listCases();
    this.state.evidences = await storage.listEvidences();
    this.state.images = await storage.listImages();
    if (this.state.selectedCaseId === id) this.selectCase(null);
    this.emit();
  }

  // ---------- 物证 ----------
  async createEvidence(data: Omit<Evidence, 'id' | 'createdAt'>): Promise<void> {
    const rec: Evidence = { ...data, id: uid('ev'), createdAt: nowTs() };
    await storage.putEvidence(rec);
    this.state.evidences = await storage.listEvidences();
    this.selectEvidence(rec.id);
    this.emit();
  }

  selectEvidence(id: string | null): void {
    this.state.selectedEvidenceId = id;
    this.state.selectedImageId = null;
    this.resetImageScope();
    this.emit();
  }

  async deleteEvidence(id: string): Promise<void> {
    await storage.deleteEvidence(id);
    this.state.evidences = await storage.listEvidences();
    this.state.images = await storage.listImages();
    if (this.state.selectedEvidenceId === id) this.selectEvidence(null);
    this.emit();
  }

  // ---------- 图像 ----------
  /** 导入文件:解码 → 灰度 → 原图/当前快照落库 → 写 import 步骤留痕 */
  async importImage(file: File, dpi: number): Promise<FpImage> {
    if (!this.state.selectedEvidenceId) throw new Error('请先选择物证');
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    void GrayImage.fromImageData(imageData); // 解码校验,实际灰度化在流水线首步完成
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    const originalKey = newKey('orig');
    const currentKey = newKey('cur');
    await storage.putBlob(originalKey, blob, 'image/png');
    await storage.putBlob(currentKey, blob, 'image/png');
    const img: FpImage = {
      id: uid('img'),
      evidenceId: this.state.selectedEvidenceId,
      fileName: file.name,
      width: bitmap.width,
      height: bitmap.height,
      dpi,
      originalKey,
      currentKey,
      importedAt: nowTs(),
    };
    await storage.putImage(img);
    this.state.images = await storage.listImages();
    await this.selectImage(img.id);
    const step: ProcessingStep = {
      id: uid('step'),
      imageId: img.id,
      kind: 'import',
      order: 1,
      params: { fileName: file.name, dpi, width: bitmap.width, height: bitmap.height, mime: file.type || 'unknown' },
      durationMs: 0,
      snapshotKey: originalKey,
      metrics: { bytes: file.size },
      createdAt: nowTs(),
    };
    await storage.addStep(step);
    await this.reloadImageScope();
    return img;
  }

  /** 导入合成测试图(带真值) */
  async importSynthetic(gray: GrayImage, fileName: string, dpi: number, gt: GroundTruth): Promise<FpImage> {
    if (!this.state.selectedEvidenceId) throw new Error('请先选择物证');
    const imageData = gray.toImageData();
    const canvas = document.createElement('canvas');
    canvas.width = gray.width;
    canvas.height = gray.height;
    canvas.getContext('2d')!.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    const originalKey = newKey('orig');
    const currentKey = newKey('cur');
    await storage.putBlob(originalKey, blob, 'image/png');
    await storage.putBlob(currentKey, blob, 'image/png');
    const img: FpImage = {
      id: uid('img'),
      evidenceId: this.state.selectedEvidenceId,
      fileName,
      width: gray.width,
      height: gray.height,
      dpi,
      originalKey,
      currentKey,
      groundTruth: gt,
      importedAt: nowTs(),
    };
    await storage.putImage(img);
    this.state.images = await storage.listImages();
    await this.selectImage(img.id);
    const step: ProcessingStep = {
      id: uid('step'),
      imageId: img.id,
      kind: 'import',
      order: 1,
      params: { fileName, dpi, width: gray.width, height: gray.height, source: 'synthetic' },
      durationMs: 0,
      snapshotKey: originalKey,
      metrics: { model: gt.orientationModel, seed: gt.seed, gtMinutiae: gt.minutiae.length },
      createdAt: nowTs(),
    };
    await storage.addStep(step);
    await this.reloadImageScope();
    return img;
  }

  async selectImage(id: string | null): Promise<void> {
    this.state.selectedImageId = id;
    await this.reloadImageScope();
    this.emit();
  }

  private resetImageScope(): void {
    this.state.steps = [];
    this.state.minutiae = [];
    this.state.changes = [];
    this.state.activeStepIndex = -1;
    this.state.lastMetrics = null;
    this.state.lastTotalMs = null;
  }

  private async reloadImageScope(): Promise<void> {
    const id = this.state.selectedImageId;
    if (!id) {
      this.resetImageScope();
      return;
    }
    this.state.steps = await storage.listSteps(id);
    this.state.minutiae = await storage.listMinutiae(id);
    this.state.changes = await storage.listChanges(id);
    this.state.activeStepIndex = this.state.steps.length - 1;
    const img = this.state.images.find((x) => x.id === id);
    this.state.lastMetrics = img?.groundTruth
      ? evaluateMinutiae(this.state.minutiae, img.groundTruth.minutiae, 4)
      : null;
  }

  get selectedImage(): FpImage | undefined {
    return this.state.images.find((x) => x.id === this.state.selectedImageId);
  }

  // ---------- 处理流水线(Worker 后台线程,界面不卡顿) ----------
  async runPipeline(params: PipelineParams): Promise<{ totalMs: number }> {
    const img = this.selectedImage;
    if (!img) throw new Error('请先选择图像');
    const blob = await storage.getBlob(img.currentKey);
    if (!blob) throw new Error('当前图像数据缺失');
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const input = GrayImage.fromImageData(ctx.getImageData(0, 0, bmp.width, bmp.height));

    const result = await runPipelineInWorker(bmp.width, bmp.height, input.data, img.id, params);
    this.state.lastTotalMs = result.totalMs;

    // 每个阶段落一条留痕(含快照 Blob),order 接续现有步骤
    const baseOrder = this.state.steps.length;
    for (let i = 0; i < result.stages.length; i++) {
      const st = result.stages[i];
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = st.width;
      snapCanvas.height = st.height;
      const stageGray = new GrayImage(st.width, st.height, st.data);
      snapCanvas.getContext('2d')!.putImageData(stageGray.toImageData(), 0, 0);
      const snapBlob = await new Promise<Blob>((res) => snapCanvas.toBlob((b) => res(b!), 'image/png'));
      const key = newKey('snap');
      await storage.putBlob(key, snapBlob, 'image/png');
      const step: ProcessingStep = {
        id: uid('step'),
        imageId: img.id,
        kind: st.name as StepKind,
        order: baseOrder + i + 1,
        params: st.params,
        durationMs: st.durationMs,
        snapshotKey: key,
        metrics: st.metrics,
        createdAt: nowTs(),
      };
      await storage.addStep(step);
    }

    // 更新当前快照与特征点(末阶段为细化骨架)
    const last = result.stages[result.stages.length - 1];
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = last.width;
    finalCanvas.height = last.height;
    finalCanvas.getContext('2d')!.putImageData(new GrayImage(last.width, last.height, last.data).toImageData(), 0, 0);
    const finalBlob = await new Promise<Blob>((res) => finalCanvas.toBlob((b) => res(b!), 'image/png'));
    const newCurrentKey = newKey('cur');
    await storage.putBlob(newCurrentKey, finalBlob, 'image/png');
    img.currentKey = newCurrentKey;
    await storage.putImage(img);
    await storage.bulkPutMinutia(result.minutiae);

    await this.reloadImageScope();
    this.state.activeStepIndex = this.state.steps.length - 1;
    this.emit();
    return { totalMs: result.totalMs };
  }

  setActiveStep(index: number): void {
    this.state.activeStepIndex = index;
    this.emit();
  }

  // ---------- 特征点人工编辑(全部留痕) ----------
  setEditMode(mode: EditMode): void {
    this.state.editMode = mode;
    this.emit();
  }

  private logChange(
    minutiaId: string,
    action: MinutiaChange['action'],
    before: MinutiaChange['before'],
    after: MinutiaChange['after'],
  ): void {
    const change: MinutiaChange = {
      id: uid('chg'),
      imageId: this.state.selectedImageId!,
      minutiaId,
      action,
      before,
      after,
      operator: this.state.operator,
      at: nowTs(),
    };
    void storage.addChange(change).then(() => this.reloadImageScope().then(() => this.emit()));
    this.state.changes.push(change);
  }

  async addMinutia(x: number, y: number, type: Minutia['type']): Promise<void> {
    const img = this.selectedImage;
    if (!img) return;
    const m: Minutia = {
      id: uid('m'),
      imageId: img.id,
      type,
      x: Math.round(x),
      y: Math.round(y),
      angle: 0,
      source: 'manual',
    };
    await storage.putMinutia(m);
    this.state.minutiae.push(m);
    this.logChange(m.id, 'add', undefined, { x: m.x, y: m.y, type: m.type, angle: m.angle });
    this.emit();
  }

  async moveMinutia(id: string, x: number, y: number): Promise<void> {
    const m = this.state.minutiae.find((q) => q.id === id);
    if (!m) return;
    const before = { x: m.x, y: m.y, type: m.type, angle: m.angle };
    m.x = Math.round(x);
    m.y = Math.round(y);
    m.source = 'edited';
    await storage.putMinutia(m);
    this.logChange(id, 'move', before, { x: m.x, y: m.y, type: m.type, angle: m.angle });
    this.emit();
  }

  async retypeMinutia(id: string): Promise<void> {
    const m = this.state.minutiae.find((q) => q.id === id);
    if (!m) return;
    const before = { x: m.x, y: m.y, type: m.type, angle: m.angle };
    m.type = m.type === 'ending' ? 'bifurcation' : 'ending';
    m.source = 'edited';
    await storage.putMinutia(m);
    this.logChange(id, 'retype', before, { x: m.x, y: m.y, type: m.type, angle: m.angle });
    this.emit();
  }

  async deleteMinutia(id: string): Promise<void> {
    const m = this.state.minutiae.find((q) => q.id === id);
    if (!m) return;
    const before = { x: m.x, y: m.y, type: m.type, angle: m.angle };
    await storage.deleteMinutia(id);
    this.state.minutiae = this.state.minutiae.filter((q) => q.id !== id);
    this.logChange(id, 'delete', before, undefined);
    this.emit();
  }

  // ---------- 报告 ----------
  async loadStepBlob(step: ProcessingStep): Promise<Blob> {
    const blob = await storage.getBlob(step.snapshotKey);
    if (!blob) throw new Error('快照缺失');
    return blob;
  }
}

export const store = new Store();
export { STEP_LABELS };
