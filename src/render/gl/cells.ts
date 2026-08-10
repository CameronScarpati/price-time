import { FRAME_HEADER_FLOATS, FRAME_STRIDE } from "../../worker/protocol";
import { cornerBuffer, createProgram } from "./context";

/**
 * The resting field: every order in the book as one instanced quad, drawn
 * straight from the worker's transferred frame (no per-order JS objects
 * anywhere on the render path).
 *
 * What the shader may and may not do is the truth rule in miniature: position
 * and length come only from frame data; the brightness curve reads the
 * order's real age; the 120ms arrival ramp and the transition dim are
 * presentation envelopes on top of instantaneous facts.
 */

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in float aTick;
layout(location=2) in float aCumBefore;
layout(location=3) in float aSats;
layout(location=4) in float aSide;
layout(location=5) in float aAge;
layout(location=6) in float aFlags;

uniform vec2 uViewPx;
uniform float uCenterTick;
uniform float uPxPerTick;
uniform float uPxPerSat;
uniform float uSeamX;
uniform float uLayout;      // 0 = seam (two-sided), 1 = spine (single column)
uniform float uMinCellPx;
// Raster cost cap: a whale can be tens of screens long; past ~1.25 viewports
// the extra pixels are invisible and pure fill-rate waste. The clamp is
// presentation (the cell still reads "longer than the screen").
uniform float uMaxCellPx;
uniform float uDim;         // mode-transition luminance dip, 0..1
uniform float uReduced;     // prefers-reduced-motion

out vec4 vColor;

const vec3 BID = vec3(0.263, 0.686, 0.961);  // blue — never red/green
const vec3 ASK = vec3(1.0, 0.667, 0.278);    // amber
const vec3 LIQ = vec3(0.71, 0.49, 1.0);      // liquidation violet

void main() {
  float y = (uCenterTick - aTick) * uPxPerTick + uViewPx.y * 0.5;
  // Row height: a 1px breathing gap between adjacent ticks while zoomed in;
  // at deep zoom-out rows go sub-pixel and neighbours merge into solid depth
  // (the honest L3→L2 melt), so no fattening below ~3px/tick.
  float rowH = uPxPerTick >= 3.0 ? max(uPxPerTick - 1.0, 2.6) : max(uPxPerTick * 0.86, 0.75);
  float len = clamp(aSats * uPxPerSat, uMinCellPx, uMaxCellPx);
  float cumPx = aCumBefore * uPxPerSat;

  float x0; float dir;
  if (uLayout < 0.5) {
    // Seam: queues grow away from the central price axis, front at the seam.
    if (aSide < 0.5) { x0 = uSeamX - cumPx; dir = -1.0; }
    else            { x0 = uSeamX + cumPx; dir =  1.0; }
  } else {
    // Spine: full-width rows, front of queue at the left edge.
    x0 = uSeamX + cumPx; dir = 1.0;
  }
  // Half-pixel insets at both ends leave a 1px optical separator between
  // queue neighbours — countable orders near the seam; at far zoom the
  // separators vanish and levels merge into solid depth. That optical
  // aggregation IS the honest L3-to-L2 transition.
  float inset = min(0.5, len * 0.25);
  float xA = x0 + dir * inset;
  float xB = x0 + dir * (len - inset);
  float x = mix(xA, xB, aCorner.x);
  float py = (y - rowH * 0.5) + aCorner.y * rowH;
  gl_Position = vec4(x / uViewPx.x * 2.0 - 1.0, 1.0 - py / uViewPx.y * 2.0, 0.0, 1.0);

  vec3 base = aFlags > 0.5 ? LIQ : mix(BID, ASK, aSide);
  // Waiting made visible: arrive bright, settle by ~8s, dim to ember by ~10min.
  // Arrival lightens toward white (hue preserved); age multiplies down.
  float settle = clamp(aAge / 8.0, 0.0, 1.0);
  float ember = clamp((aAge - 60.0) / 540.0, 0.0, 1.0);
  float flare = (uReduced > 0.5 ? 0.1 : 0.28) * (1.0 - settle);
  vec3 color = mix(base, vec3(1.0), flare) * mix(1.0, 0.4, ember);
  float alpha = 0.92;
  if (uReduced < 0.5) alpha *= clamp(aAge / 0.12, 0.3, 1.0);
  vColor = vec4(color * (1.0 - uDim * 0.55), alpha);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

export interface CellUniforms {
  viewW: number;
  viewH: number;
  centerTick: number;
  pxPerTick: number;
  pxPerSat: number;
  seamX: number;
  layout: 0 | 1;
  minCellPx: number;
  maxCellPx: number;
  dim: number;
  reduced: boolean;
}

export class CellPipeline {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private capacityBytes = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    this.vao = gl.createVertexArray()!;
    this.instanceBuffer = gl.createBuffer()!;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const strideBytes = FRAME_STRIDE * 4;
    for (let i = 0; i < FRAME_STRIDE; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 1, gl.FLOAT, false, strideBytes, i * 4);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);

    this.uniforms = {};
    for (const name of [
      "uViewPx", "uCenterTick", "uPxPerTick", "uPxPerSat", "uSeamX",
      "uLayout", "uMinCellPx", "uMaxCellPx", "uDim", "uReduced",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  draw(frame: Float32Array, instances: number, u: CellUniforms): void {
    const gl = this.gl;
    if (instances === 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const bytes = (FRAME_HEADER_FLOATS + instances * FRAME_STRIDE) * 4;
    if (bytes > this.capacityBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, frame.byteLength, gl.DYNAMIC_DRAW);
      this.capacityBytes = frame.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame, 0, FRAME_HEADER_FLOATS + instances * FRAME_STRIDE);
    // Instance attributes start after the header.
    const strideBytes = FRAME_STRIDE * 4;
    for (let i = 0; i < FRAME_STRIDE; i++) {
      gl.vertexAttribPointer(1 + i, 1, gl.FLOAT, false, strideBytes, FRAME_HEADER_FLOATS * 4 + i * 4);
    }
    gl.uniform2f(this.uniforms.uViewPx, u.viewW, u.viewH);
    gl.uniform1f(this.uniforms.uCenterTick, u.centerTick);
    gl.uniform1f(this.uniforms.uPxPerTick, u.pxPerTick);
    gl.uniform1f(this.uniforms.uPxPerSat, u.pxPerSat);
    gl.uniform1f(this.uniforms.uSeamX, u.seamX);
    gl.uniform1f(this.uniforms.uLayout, u.layout);
    gl.uniform1f(this.uniforms.uMinCellPx, u.minCellPx);
    gl.uniform1f(this.uniforms.uMaxCellPx, u.maxCellPx);
    gl.uniform1f(this.uniforms.uDim, u.dim);
    gl.uniform1f(this.uniforms.uReduced, u.reduced ? 1 : 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
    gl.bindVertexArray(null);
  }
}
