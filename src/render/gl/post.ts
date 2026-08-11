import { createProgram } from "./context";

/**
 * Full-screen passes that give the piece its phosphor calm:
 *
 * - FADE: instead of a hard clear, the previous frame is washed toward the
 *   background a little each frame, leaving ~100ms afterglow on everything
 *   that moved. This is the single biggest "flow, don't pop" ingredient
 *   (Bookmap's continuity, a CRT's forgiveness) and it is presentation: a
 *   brief decay of what really was there, exactly like a flash's decay.
 * - MEMBRANE: a faint luminous band inside the spread gap, whose height IS
 *   the spread — the market's breathing, made barely visible. Data-driven.
 * - VIGNETTE: a static darkening toward the edges; not motion, just a room.
 */

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform int uMode;
uniform vec4 uColor;      // fade: bg color + wash alpha
uniform vec2 uViewPx;
uniform float uMidYPx;
uniform float uHalfHPx;   // membrane half-height (spread/2 in px, clamped)
uniform float uSeamXPx;
out vec4 outColor;
void main() {
  if (uMode == 0) {
    outColor = uColor;                       // normal blend: wash toward bg
  } else if (uMode == 1) {
    vec2 px = vUv * uViewPx;
    float dy = abs(px.y - uMidYPx) / max(uHalfHPx, 2.0);
    float dx = abs(px.x - uSeamXPx) / (uViewPx.x * 0.5);
    float band = exp(-dy * dy * 0.9) * exp(-dx * dx * 2.2);
    vec3 glow = vec3(0.62, 0.72, 0.85);      // cool neutral between the hues
    float a = band * uColor.a;
    outColor = vec4(glow * a, a);            // premultiplied additive
  } else {
    float d = distance(vUv, vec2(0.5));
    float v = smoothstep(0.45, 0.95, d) * uColor.a;
    outColor = vec4(vec3(1.0 - v), 1.0);     // multiplicative darkening
  }
}`;

export class PostPipeline {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly u: Record<string, WebGLUniformLocation>;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, 2]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.u = {};
    for (const name of ["uMode", "uColor", "uViewPx", "uMidYPx", "uHalfHPx", "uSeamXPx"]) {
      this.u[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  private draw(mode: number, color: [number, number, number, number], extra?: {
    viewW: number; viewH: number; midY: number; halfH: number; seamX: number;
  }): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform4f(this.u.uColor, ...color);
    if (extra) {
      gl.uniform2f(this.u.uViewPx, extra.viewW, extra.viewH);
      gl.uniform1f(this.u.uMidYPx, extra.midY);
      gl.uniform1f(this.u.uHalfHPx, extra.halfH);
      gl.uniform1f(this.u.uSeamXPx, extra.seamX);
    }
    gl.enable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Wash the previous frame toward the background; alpha sets decay speed. */
  fade(bg: [number, number, number], alpha: number): void {
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.draw(0, [bg[0], bg[1], bg[2], alpha]);
  }

  membrane(viewW: number, viewH: number, midY: number, halfH: number, seamX: number, alpha: number): void {
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    this.draw(1, [0, 0, 0, alpha], { viewW, viewH, midY, halfH, seamX });
  }

  vignette(strength: number): void {
    this.gl.blendFunc(this.gl.ZERO, this.gl.SRC_COLOR);
    this.draw(2, [0, 0, 0, strength]);
  }
}
