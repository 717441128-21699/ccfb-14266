/**
 * 迭代 radix-2 Cooley-Tukey FFT,实部/虚部分离存储。
 * 仅支持 2 的幂长度。二维 FFT 按行、列分别做一维变换。
 */

function fft1d(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂,收到 ${n}`);

  // 位逆序置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (inverse ? -2 : 2) * Math.PI / len;
    const wBaseR = Math.cos(ang);
    const wBaseI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        const ur = re[a];
        const ui = im[a];
        re[a] = ur + vr;
        im[a] = ui + vi;
        re[b] = ur - vr;
        im[b] = ui - vi;
        const nwr = wr * wBaseR - wi * wBaseI;
        wi = wr * wBaseI + wi * wBaseR;
        wr = nwr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export interface Fft2dBuffer {
  rows: number;
  cols: number;
  re: Float32Array;
  im: Float32Array;
}

export function nextPow2(n: number): number {
  return 1 << Math.ceil(Math.log2(Math.max(2, n)));
}

export function fft2d(buf: Fft2dBuffer, inverse = false): void {
  const { rows, cols, re, im } = buf;
  const rowRe = new Float32Array(cols);
  const rowIm = new Float32Array(cols);
  // 行变换
  for (let y = 0; y < rows; y++) {
    const off = y * cols;
    for (let x = 0; x < cols; x++) {
      rowRe[x] = re[off + x];
      rowIm[x] = im[off + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let x = 0; x < cols; x++) {
      re[off + x] = rowRe[x];
      im[off + x] = rowIm[x];
    }
  }
  // 列变换
  const colRe = new Float32Array(rows);
  const colIm = new Float32Array(rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      colRe[y] = re[y * cols + x];
      colIm[y] = im[y * cols + x];
    }
    fft1d(colRe, colIm, inverse);
    for (let y = 0; y < rows; y++) {
      re[y * cols + x] = colRe[y];
      im[y * cols + x] = colIm[y];
    }
  }
}

/** 前向变换:灰度图(自动补零到 2 的幂)→ 频谱缓冲 */
export function forwardFft(img: { width: number; height: number; data: Float32Array }): Fft2dBuffer {
  const cols = nextPow2(img.width);
  const rows = nextPow2(img.height);
  const re = new Float32Array(rows * cols);
  const im = new Float32Array(rows * cols);
  for (let y = 0; y < img.height; y++) {
    const srcOff = y * img.width;
    const dstOff = y * cols;
    re.set(img.data.subarray(srcOff, srcOff + img.width), dstOff);
  }
  const buf = { rows, cols, re, im };
  fft2d(buf, false);
  return buf;
}

export function inverseFft(buf: Fft2dBuffer): Float32Array {
  const out = new Float32Array(buf.rows * buf.cols);
  fft2d(buf, true);
  out.set(buf.re);
  return out;
}
