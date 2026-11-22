/** 各处理 pass 的 GLSL 300 es 片元着色器源码 */

export const SHADERS = {
  /** 可分离高斯:u_horizontal=1 横向,否则纵向;u_kernel 预计算权重 */
  gaussian: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform float u_kernel[31];
uniform int u_radius;
uniform int u_horizontal;
out float o_val;
float px(vec2 uv) { return texture(u_src, uv).r; }
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 step = (u_horizontal == 1) ? vec2(1.0 / u_size.x, 0.0) : vec2(0.0, 1.0 / u_size.y);
  float acc = 0.0;
  for (int k = -15; k <= 15; k++) {
    if (k < -u_radius || k > u_radius) continue;
    acc += px(uv + step * float(k)) * u_kernel[k + u_radius];
  }
  o_val = clamp(acc, 0.0, 255.0);
}`,

  /** Sobel 梯度,输出编码:R=gx, G=gy, B=幅值(幅值单独场景另用) */
  sobel: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
out vec3 o_grad;
float px(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(u_size) - 1);
  return texelFetch(u_src, p, 0).r;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float tl = px(c + ivec2(-1,-1)), t = px(c + ivec2(0,-1)), tr = px(c + ivec2(1,-1));
  float l  = px(c + ivec2(-1, 0)),                      r  = px(c + ivec2(1, 0));
  float bl = px(c + ivec2(-1, 1)), b = px(c + ivec2(0, 1)), br = px(c + ivec2(1, 1));
  float gx = tr + 2.0*r + br - tl - 2.0*l - bl;
  float gy = bl + 2.0*b + br - tl - 2.0*t - tr;
  o_grad = vec3(gx, gy, length(vec2(gx, gy)));
}`,

  /** 方向 Gabor:方向/频率以纹理传入(R=双角cos, G=双角sin, B=freq) */
  gabor: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_field;
uniform vec2 u_size;
uniform float u_sigmaXFactor;
uniform float u_sigmaYFactor;
uniform float u_radiusFactor;
uniform float u_coherenceGate;
out float o_val;
float px(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(u_size) - 1);
  return texelFetch(u_src, p, 0).r;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 fld = texelFetch(u_field, c, 0);
  float coh = fld.a;
  if (coh < u_coherenceGate) { o_val = px(c); return; }
  float twoTheta = atan(fld.g, fld.r);
  float theta = 0.5 * twoTheta;
  float freq = max(1e-4, fld.b);
  float period = 1.0 / freq;
  float sigmaX = u_sigmaXFactor * period;
  float sigmaY = u_sigmaYFactor * period;
  int radius = max(2, int(round(u_radiusFactor * period)));
  vec2 nDir = vec2(cos(theta + 1.5707963), sin(theta + 1.5707963));
  vec2 tDir = vec2(-nDir.y, nDir.x);
  float acc = 0.0;
  float wsum = 0.0;
  for (int dy = -48; dy <= 48; dy++) {
    if (dy < -radius || dy > radius) continue;
    for (int dx = -48; dx <= 48; dx++) {
      if (dx < -radius || dx > radius) continue;
      vec2 d = vec2(float(dx), float(dy));
      float gxn = dot(d, nDir);
      float gyt = dot(d, tDir);
      float g = exp(-0.5 * (gxn*gxn/(sigmaX*sigmaX) + gyt*gyt/(sigmaY*sigmaY)))
              * cos(6.2831853 * freq * gxn);
      acc += px(c + ivec2(dx, dy)) * g;
      wsum += abs(g);
    }
  }
  float resp = wsum > 0.0 ? acc / wsum : px(c);
  o_val = clamp(resp, 0.0, 255.0);
}`,

  /** 自适应二值化:局部均值纹理 u_mean,阈值 = mean * factor */
  binarize: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_mean;
uniform vec2 u_size;
uniform float u_factor;
out float o_val;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_src, c, 0).r;
  float m = texelFetch(u_mean, c, 0).r;
  o_val = v < m * u_factor ? 0.0 : 255.0;
}`,

  /** 盒式局部均值(可分离:u_horizontal 控制方向,半径 u_radius) */
  box: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform int u_radius;
uniform int u_horizontal;
out float o_val;
float px(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(u_size) - 1);
  return texelFetch(u_src, p, 0).r;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float sum = 0.0;
  int n = 0;
  for (int k = -48; k <= 48; k++) {
    if (k < -u_radius || k > u_radius) continue;
    ivec2 d = (u_horizontal == 1) ? ivec2(k, 0) : ivec2(0, k);
    sum += px(c + d);
    n++;
  }
  o_val = sum / float(n);
}`,

  /** 灰度显示:0..255 单通道 → RGBA */
  display: `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
out vec4 o_color;
void main() {
  float v = texture(u_src, gl_FragCoord.xy / u_size).r / 255.0;
  o_color = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,
};
