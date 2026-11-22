// 全局数据模型:案件 / 物证 / 图像 / 处理步骤留痕 / 特征点及编辑记录
export type ID = string;

export type StepKind =
  | 'import'
  | 'normalize'
  | 'denoise'
  | 'bgSuppress'
  | 'orientation'
  | 'frequency'
  | 'gabor'
  | 'binarize'
  | 'thin'
  | 'minutiae';

/** 单个步骤的参数与产物,全部可序列化,用于回溯与报告 */
export interface ProcessingStep {
  id: ID;
  imageId: ID;
  kind: StepKind;
  /** 步骤序号,从 1 开始,严格递增 */
  order: number;
  /** 算法参数,原样存档,报告中逐项打印 */
  params: Record<string, number | string | boolean>;
  /** 步骤耗时(毫秒) */
  durationMs: number;
  /** 处理后快照 Blob 的 key(storeName=blobs) */
  snapshotKey: string;
  /** 算法内部的中间度量,如频域峰坐标、方向场相干性 */
  metrics: Record<string, number | string | number[]>;
  createdAt: number;
  note?: string;
}

export type MinutiaType = 'ending' | 'bifurcation';
export type MinutiaSource = 'auto' | 'manual' | 'edited' | 'deleted';

export interface Minutia {
  id: ID;
  imageId: ID;
  type: MinutiaType;
  /** 像素坐标(原始图像坐标系) */
  x: number;
  y: number;
  /** 脊线方向,弧度,范围 [0, π) */
  angle: number;
  source: MinutiaSource;
  /** 自动提取时的置信度 0..1,人工点为空 */
  confidence?: number;
}

/** 特征点的每一次人工改动都落库,不可删除 */
export interface MinutiaChange {
  id: ID;
  imageId: ID;
  minutiaId: ID;
  action: 'add' | 'move' | 'retype' | 'delete';
  before?: { x: number; y: number; type: MinutiaType; angle: number };
  after?: { x: number; y: number; type: MinutiaType; angle: number };
  operator: string;
  at: number;
}

export interface CaseRecord {
  id: ID;
  name: string;
  caseNumber: string;
  investigator: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface Evidence {
  id: ID;
  caseId: ID;
  name: string;
  /** 承痕客体类型:包装袋 / 钞票 / 瓷砖 / 纸张 等 */
  surface: string;
  seizedAt: string;
  note: string;
  createdAt: number;
}

export interface FpImage {
  id: ID;
  evidenceId: ID;
  fileName: string;
  width: number;
  height: number;
  dpi: number;
  /** 原图 Blob key */
  originalKey: string;
  /** 当前最新结果 Blob key(任一处理步骤后更新) */
  currentKey: string;
  /** 合成图附带的真值,真实案件图为空 */
  groundTruth?: GroundTruth;
  importedAt: number;
}

export interface GroundTruthMinutia {
  x: number;
  y: number;
  type: MinutiaType;
  angle: number;
}

export interface GroundTruth {
  orientationModel: 'loop' | 'arch' | 'whorl';
  seed: number;
  ridgeFrequency: number;
  backgroundKinds: string[];
  /** 官方真值:干净脊线图骨架上提取的特征点,与渲染几何一致 */
  minutiae: GroundTruthMinutia[];
  /** 合成时手工埋设的特征点,仅作对照参考 */
  plantedMinutiae?: GroundTruthMinutia[];
}

export interface BlobRecord {
  key: string;
  blob: Blob;
  mime: string;
  createdAt: number;
}

export const STEP_LABELS: Record<StepKind, string> = {
  import: '导入与解码',
  normalize: '灰度化与对比度归一化',
  denoise: '高斯去噪',
  bgSuppress: '频域周期性背景抑制',
  orientation: '方向场估计',
  frequency: '频率场估计',
  gabor: '方向 Gabor 滤波增强',
  binarize: '自适应二值化',
  thin: '细化(Zhang-Suen)',
  minutiae: '细节特征点自动提取',
};
