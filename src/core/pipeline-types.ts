import type { BgSuppressParams } from './background';
import type { OrientationParams } from './orientation';
import type { FrequencyParams } from './frequency';
import type { GaborParams } from './gabor';
import type { BinarizeParams } from './binarize';
import type { MinutiaDetectParams } from './minutiae';
import type { GrayImage } from './image';

export type { BgSuppressParams, OrientationParams, FrequencyParams, GaborParams, BinarizeParams, MinutiaDetectParams };

/** 全链路参数包,每一项都原样进入步骤留痕与报告 */
export interface PipelineParams {
  denoiseSigma: number;
  background: BgSuppressParams;
  orientation: OrientationParams;
  frequency: FrequencyParams;
  gabor: GaborParams;
  binarize: BinarizeParams;
  minutia: MinutiaDetectParams;
}

export interface PipelineStage {
  name: string;
  image: GrayImage;
  durationMs: number;
  params: Record<string, number | string | boolean>;
  metrics: Record<string, number | string | number[]>;
}

export { DEFAULT_BG_PARAMS } from './background';
export { DEFAULT_ORIENTATION_PARAMS } from './orientation';
export { DEFAULT_FREQUENCY_PARAMS } from './frequency';
export { DEFAULT_GABOR_PARAMS } from './gabor';
export { DEFAULT_BINARIZE_PARAMS } from './binarize';
export { DEFAULT_MINUTIA_PARAMS } from './minutiae';

import { DEFAULT_BG_PARAMS } from './background';
import { DEFAULT_ORIENTATION_PARAMS } from './orientation';
import { DEFAULT_FREQUENCY_PARAMS } from './frequency';
import { DEFAULT_GABOR_PARAMS } from './gabor';
import { DEFAULT_BINARIZE_PARAMS } from './binarize';
import { DEFAULT_MINUTIA_PARAMS } from './minutiae';

export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  denoiseSigma: 0.8,
  background: DEFAULT_BG_PARAMS,
  orientation: DEFAULT_ORIENTATION_PARAMS,
  frequency: DEFAULT_FREQUENCY_PARAMS,
  gabor: DEFAULT_GABOR_PARAMS,
  binarize: DEFAULT_BINARIZE_PARAMS,
  minutia: DEFAULT_MINUTIA_PARAMS,
};
