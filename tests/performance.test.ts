import { describe, it, expect } from 'vitest';
import { synthesize } from '../src/core/synthesis';
import { runCpuPipeline } from '../src/core/pipeline';

/**
 * 需求 4:1000dpi 图从导入到增强完成 ≤4 秒。
 * 1000dpi 下单枚指纹现场裁剪图典型为 512²~1024²,这里逐档计时。
 * 注意:Node 无 WebGL2,测的是 Worker 内同款 CPU 路径的算法净耗时;
 * 浏览器中去噪/Gabor/二值化走 WebGL2 只会更快。
 */
describe('性能基准(需求 4)', () => {
  const sizes = [256, 384, 512, 768];

  for (const size of sizes) {
    it(
      `合成 ${size}×${size} 全流水线计时`,
      () => {
      const { image } = synthesize({
        width: size,
        height: size,
        seed: 77,
        model: 'loop',
        ridgePeriod: 10,
        backgrounds: ['fabric', 'banknote'],
        backgroundStrength: 0.9,
        noiseSigma: 7,
        minutiaCount: 10,
      });
      const t0 = performance.now();
      const result = runCpuPipeline(image, 'bench');
      const elapsed = performance.now() - t0;
      const perStage = result.stages.map((s) => `${s.name}:${s.durationMs.toFixed(0)}ms`).join(' ');
      // eslint-disable-next-line no-console
      console.log(`\n[${size}px] 总耗时 ${elapsed.toFixed(0)}ms | ${perStage}`);
      // 需求 4 硬门槛:全部基准尺寸(含 1000dpi 主力 512²)算法净耗时 ≤4 秒
      expect(elapsed).toBeLessThan(4000);
      },
      20000,
    );
  }
});
