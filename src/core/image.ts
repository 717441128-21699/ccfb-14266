/** 灰度浮点图像,数值范围约定 0..255 */
export class GrayImage {
  constructor(
    public width: number,
    public height: number,
    public data: Float32Array,
  ) {
    if (data.length !== width * height) throw new Error('GrayImage 数据长度不匹配');
  }

  static blank(width: number, height: number, fill = 0): GrayImage {
    return new GrayImage(width, height, new Float32Array(width * height).fill(fill));
  }

  static fromImageData(imageData: ImageData): GrayImage {
    const { width, height, data } = imageData;
    const out = new Float32Array(width * height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      // ITU-R BT.601 亮度
      out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    return new GrayImage(width, height, out);
  }

  toImageData(): ImageData {
    const img = new ImageData(this.width, this.height);
    const d = img.data;
    for (let i = 0; i < this.data.length; i++) {
      const v = Math.max(0, Math.min(255, this.data[i]));
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = v;
      d[j + 3] = 255;
    }
    return img;
  }

  clone(): GrayImage {
    return new GrayImage(this.width, this.height, new Float32Array(this.data));
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  /** 边界 clamp 采样 */
  at(x: number, y: number): number {
    const cx = x < 0 ? 0 : x >= this.width ? this.width - 1 : x;
    const cy = y < 0 ? 0 : y >= this.height ? this.height - 1 : y;
    return this.data[cy * this.width + cx];
  }

  /** 双线性采样(浮点坐标) */
  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width - 1 || y >= this.height - 1) return this.at(Math.round(x), Math.round(y));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const i = y0 * this.width + x0;
    const a = this.data[i] * (1 - tx) + this.data[i + 1] * tx;
    const b = this.data[i + this.width] * (1 - tx) + this.data[i + this.width + 1] * tx;
    return a * (1 - ty) + b * ty;
  }

  mean(): number {
    let s = 0;
    for (const v of this.data) s += v;
    return s / this.data.length;
  }
}
