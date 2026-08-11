import { createProgram } from "./context";

/**
 * The two non-field passes, built for fill-rate discipline on 3x phones:
 *
 * - BACKDROP: room gradient and vignette combined into ONE opaque fullscreen
 *   draw that also replaces the clear — what used to be clear + two blended
 *   fullscreen passes is a single unblended write. Static by design.
 * - MEMBRANE: a faint luminous band inside the spread gap, whose height IS
 *   the spread — the market's breathing, made barely visible. Scissored to
 *   its band so its fragments never touch (or tint) the rest of the frame,
 *   and faded to true zero horizontally so it can never read as a beam
 *   shooting past the rows it belongs to.
 *
 * (Two lineage notes, both owner-verified on hardware: a whole-field phosphor
 * FADE pass was removed — afterimage smearing; and the spine membrane once
 * spanned the full screen width — it read as a stray laser.)
 */

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

// highp on purpose: a 0.05-alpha gaussian quantizes into visible steps in
// mediump on mobile GPUs — the membrane turned into banded grime.
const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform int uMode;
uniform vec2 uViewPx;
uniform float uAlpha;
uniform float uMidYPx;
uniform float uHalfHPx;   // membrane half-height (spread/2 in px, clamped)
uniform float uSeamXPx;   // membrane horizontal anchor
uniform float uFalloff;   // membrane horizontal gaussian width
uniform vec2 uShape;      // vignette ellipse shape (spine weights top/bottom)
uniform float uVignette;
out vec4 outColor;

// 1-LSB hash dither: near-black gradients band on 8-bit OLED without it.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  if (uMode == 0) {
    // Backdrop: #0E141B at center easing to #080B0F at the corners, with the
    // vignette folded into the same radial term. One opaque write.
    vec2 q = (vUv - 0.5) * vec2(uViewPx.x / uViewPx.y, 1.0);
    float d = length(q);
    vec3 bg = mix(vec3(0.055, 0.078, 0.106), vec3(0.031, 0.043, 0.059),
      smoothstep(0.15, 0.9, d));
    float v = smoothstep(0.35, 1.05, length(q * uShape)) * uVignette;
    outColor = vec4(bg * (1.0 - v) + vec3((hash(gl_FragCoord.xy) - 0.5) / 255.0), 1.0);
  } else {
    // The membrane: light escaping the seam between the two liquidity
    // fields. Core+halo so there is a highlight to catch the eye, not one
    // wide smear; temperature borrowed from the sides it separates (warm
    // toward the asks above, cool toward the bids below — no third hue).
    // px.y is top-down to match tickToY's convention (vUv.y is bottom-up).
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uViewPx;
    float dy = (px.y - uMidYPx) / max(uHalfHPx, 2.0);
    float dx = abs(px.x - uSeamXPx) / (uViewPx.x * 0.5);
    float core = exp(-dy * dy * 3.0);
    float halo = exp(-dy * dy * 0.35);
    // Dies to TRUE zero before the frame edge, every layout: an edge-to-edge
    // 1-LSB tint reads as screen grime, and a band running past the rows it
    // belongs to reads as a beam.
    float band = (0.7 * core + 0.3 * halo) * exp(-dx * dx * uFalloff)
      * smoothstep(1.1, 0.5, dx);
    vec3 warm = vec3(0.98, 0.82, 0.60);
    vec3 cool = vec3(0.50, 0.72, 0.95);
    vec3 glow = mix(cool, warm,
      clamp(0.5 + (uMidYPx - px.y) / max(uHalfHPx * 4.0, 8.0), 0.0, 1.0));
    float a = band * uAlpha;
    a = max(a + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 0.0);
    outColor = vec4(glow * a, a);            // premultiplied additive
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
    for (const name of [
      "uMode", "uViewPx", "uAlpha", "uMidYPx", "uHalfHPx", "uSeamXPx",
      "uFalloff", "uShape", "uVignette",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  /** Opaque room + vignette; replaces the frame clear entirely. */
  backdrop(viewW: number, viewH: number, vignette: number, shapeX: number, shapeY: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.u.uMode, 0);
    gl.uniform2f(this.u.uViewPx, viewW, viewH);
    gl.uniform1f(this.u.uVignette, vignette);
    gl.uniform2f(this.u.uShape, shapeX, shapeY);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** The spread's light. Scissored: fragments outside the band cost nothing
   * and can tint nothing. `dpr` converts CSS-space bounds to device pixels
   * (scissor works in device space, y up from the bottom). */
  membrane(
    viewW: number, viewH: number, midY: number, halfH: number, seamX: number,
    alpha: number, falloff: number, dpr: number,
  ): void {
    const gl = this.gl;
    const bandCss = Math.min(halfH * 6 + 24, viewH);
    const yTopCss = Math.max(midY - bandCss, 0);
    const yBottomCss = Math.min(midY + bandCss, viewH);
    if (yBottomCss <= yTopCss) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      0,
      Math.floor((viewH - yBottomCss) * dpr),
      Math.ceil(viewW * dpr),
      Math.ceil((yBottomCss - yTopCss) * dpr),
    );
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.u.uMode, 1);
    gl.uniform2f(this.u.uViewPx, viewW, viewH);
    gl.uniform1f(this.u.uAlpha, alpha);
    gl.uniform1f(this.u.uMidYPx, midY);
    gl.uniform1f(this.u.uHalfHPx, halfH);
    gl.uniform1f(this.u.uSeamXPx, seamX);
    gl.uniform1f(this.u.uFalloff, falloff);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }
}
