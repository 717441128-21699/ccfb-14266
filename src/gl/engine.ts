/**
 * WebGL2 计算引擎(需求 4:滤波放 WebGL2)
 * 灰度图以 R32F 浮点纹理存储,全屏四边形 + 片元着色器做逐像素/邻域计算,
 * ping-pong 纹理串接各 pass。FFT 仍由 Worker 内的 CPU radix-2 完成
 * (一次性的全局变换,CPU 版在 1024² 上约百毫秒级,且免引入大依赖)。
 */

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败: ${log}\n${src}`);
  }
  return sh;
}

export class GlProgram {
  program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    fragSrc: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`程序链接失败: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }
}

export class GlEngine {
  gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private fieldTex: WebGLTexture;
  private meanTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  width = 0;
  height = 0;
  readonly supportsFloat: boolean;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
    });
    if (!gl) throw new Error('当前环境不支持 WebGL2');
    this.gl = gl;
    const ext = gl.getExtension('EXT_color_buffer_float');
    this.supportsFloat = !!ext;
    if (!ext) throw new Error('缺少 EXT_color_buffer_float,无法做浮点纹理计算');

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texA = this.createTexture(gl.R32F, gl.RED, gl.FLOAT);
    this.texB = this.createTexture(gl.R32F, gl.RED, gl.FLOAT);
    this.fieldTex = this.createTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.meanTex = this.createTexture(gl.R32F, gl.RED, gl.FLOAT);
    this.fbo = gl.createFramebuffer()!;
  }

  private createTexture(internal: number, format: number, type: number): WebGLTexture {
    const t = this.gl.createTexture()!;
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, internal, 1, 1, 0, format, type, null);
    return t;
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const specs: [WebGLTexture, number, number][] = [
      [this.texA, this.gl.R32F, this.gl.RED],
      [this.texB, this.gl.R32F, this.gl.RED],
      [this.fieldTex, this.gl.RGBA32F, this.gl.RGBA],
      [this.meanTex, this.gl.R32F, this.gl.RED],
    ];
    for (const [t, internal, format] of specs) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, t);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, internal, w, h, 0, format, this.gl.FLOAT, null);
    }
  }

  /** CPU 灰度数据上传到纹理 A */
  upload(img: Float32Array, w: number, h: number): void {
    this.resize(w, h);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texA);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, w, h, this.gl.RED, this.gl.FLOAT, img);
  }

  /** 上传逐像素方向/频率/相干场(R=cos2θ G=sin2θ B=freq A=coherence) */
  uploadField(field: Float32Array, w: number, h: number): void {
    this.resize(w, h);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.fieldTex);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, w, h, this.gl.RGBA, this.gl.FLOAT, field);
  }

  getFieldTexture(): WebGLTexture {
    return this.fieldTex;
  }

  getMeanTexture(): WebGLTexture {
    return this.meanTex;
  }

  /** 把 texB(垂直 box 输出)拷贝到均值纹理 */
  copyTexBToMean(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texB, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindTexture(gl.TEXTURE_2D, this.meanTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.width, this.height);
  }

  /** 绑定附加纹理单元 */
  bindExtra(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  private attach(tex: WebGLTexture): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, tex, 0);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  /** 运行一个 pass:输入纹理 → 输出纹理,ping-pong */
  runPass(prog: GlProgram, bindInputs: (gl: WebGL2RenderingContext) => void, swap = true): void {
    const src = this.texA;
    const dst = this.texB;
    this.attach(dst);
    prog.use();
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, src);
    this.gl.uniform1i(prog.uniform('u_src'), 0);
    this.gl.uniform2f(prog.uniform('u_size'), this.width, this.height);
    bindInputs(this.gl);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    if (swap) {
      const tmp = this.texA;
      this.texA = this.texB;
      this.texB = tmp;
    }
  }

  /** 运行 pass 并把结果写到指定纹理(不参与 ping-pong) */
  runPassTo(prog: GlProgram, dst: WebGLTexture, bindInputs: (gl: WebGL2RenderingContext) => void): void {
    this.attach(dst);
    prog.use();
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texA);
    this.gl.uniform1i(prog.uniform('u_src'), 0);
    this.gl.uniform2f(prog.uniform('u_size'), this.width, this.height);
    bindInputs(this.gl);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /** 当前结果读回 CPU */
  readback(): Float32Array {
    const out = new Float32Array(this.width * this.height);
    this.attach(this.texA);
    this.gl.readPixels(0, 0, this.width, this.height, this.gl.RED, this.gl.FLOAT, out);
    // WebGL 像素原点在左下,翻转回上行序
    const flipped = new Float32Array(out.length);
    const row = this.width;
    for (let y = 0; y < this.height; y++) {
      flipped.set(out.subarray((this.height - 1 - y) * row, (this.height - y) * row), y * row);
    }
    return flipped;
  }

  /** 把当前纹理画到可见 canvas(预览用) */
  blitToCanvas(prog: GlProgram): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    prog.use();
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texA);
    this.gl.uniform1i(prog.uniform('u_src'), 0);
    this.gl.uniform2f(prog.uniform('u_size'), this.width, this.height);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texA);
    gl.deleteTexture(this.texB);
    gl.deleteTexture(this.fieldTex);
    gl.deleteTexture(this.meanTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
  }
}
