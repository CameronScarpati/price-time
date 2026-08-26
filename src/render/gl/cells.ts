import { FRAME_HEADER_FLOATS, FRAME_STRIDE } from "../../worker/protocol";
import { cornerBuffer, createProgram } from "./context";

/**
 * The resting field: every order in the book as one instanced quad, drawn
 * straight from the worker's transferred frame (no per-order JS objects
 * anywhere on the render path).
 *
 * What the shader may and may not do is the truth rule in miniature: position
 * and length come only from frame data; the brightness curve reads the
 * order's real age, subtracted here from two numbers the worker supplied
 * (when the order rested, and the frame's clock) rather than derived — the
 * renderer still invents nothing; the 120ms arrival ramp and the transition
 * dim are presentation envelopes on top of instantaneous facts.
 */

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in float aTick;
layout(location=2) in float aCumBefore;
layout(location=3) in float aSats;
layout(location=4) in float aSide;
layout(location=5) in float aRestedAtSec;
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
uniform float uCenterYPx;   // screen y of the camera's center tick
uniform float uDpr;         // device pixel ratio, for separator snapping
// The frame's pack-time clock, same epoch as aRestedAtSec. Age is computed
// HERE rather than packed per order, so the instance block is byte-identical
// between market events and the pack and the upload can both be skipped.
uniform float uNowSec;

out vec4 vColor;
out vec2 vUv;
out vec2 vSizePx;
out float vClamped;
out float vYPx;

const vec3 BID = vec3(0.263, 0.686, 0.961);  // blue — never red/green
const vec3 ASK = vec3(1.0, 0.667, 0.278);    // amber
const vec3 LIQ = vec3(0.71, 0.49, 1.0);      // liquidation violet
// Age anchors: arrivals lighten toward the hot tint, embers sink along a hue
// path (amber → burnt sienna, blue → deep sea) instead of a grey lerp.
// Luminance still monotonically encodes age; only the journey is richer.
const vec3 BID_HOT = vec3(0.78, 0.92, 1.0);
const vec3 ASK_HOT = vec3(1.0, 0.90, 0.70);
const vec3 BID_EMBER = vec3(0.10, 0.24, 0.42);
const vec3 ASK_EMBER = vec3(0.45, 0.25, 0.10);

void main() {
  float y = (uCenterTick - aTick) * uPxPerTick + uCenterYPx;
  // Row height: a 1px breathing gap between adjacent ticks while zoomed in;
  // at deep zoom-out rows go sub-pixel and neighbours merge into solid depth
  // (the honest L3→L2 melt), so no fattening below ~3px/tick.
  float rowH = uPxPerTick >= 3.0 ? max(uPxPerTick - 1.0, 2.6) : max(uPxPerTick * 0.86, 0.75);
  // Round the row height to a whole number of DEVICE pixels. Both edges are
  // snapped to that grid below, so a height that is 12.74 device pixels
  // renders as 12 or 13 depending on where the row happens to sit — and it
  // flips between them as the field slides under a pan, each row at its own
  // moment. That flicker is what "the bars glitch when I scroll" is. Whole
  // device pixels make every row the same height, always, phase or no phase.
  rowH = max(floor(rowH * uDpr + 0.5), 1.0) / uDpr;
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
  // Snap both ends to the device grid: the 1px optical separators between
  // queue neighbours otherwise render anywhere from 1 to 2+ device pixels
  // depending on subpixel phase — machined, not hand-cut. A ≤0.5-device-px
  // snap changes no ordering or magnitude a viewer could read.
  xA = floor(xA * uDpr + 0.5) / uDpr;
  xB = floor(xB * uDpr + 0.5) / uDpr;
  // Dust must stay visible: never snap a cell to zero width.
  if (xA == xB) xB = xA + dir / uDpr;
  float x = mix(xA, xB, aCorner.x);
  // Rows get the same device-grid snap as the vertical separators: an
  // unsnapped top/bottom edge lands mid-device-pixel and every box reads
  // faintly soft, worst at 3x where one CSS pixel is three chances to blur.
  float yT = floor((y - rowH * 0.5) * uDpr + 0.5) / uDpr;
  float yB = floor((y + rowH * 0.5) * uDpr + 0.5) / uDpr;
  if (yT == yB) yB = yT + 1.0 / uDpr;
  float py = mix(yT, yB, aCorner.y);
  gl_Position = vec4(x / uViewPx.x * 2.0 - 1.0, 1.0 - py / uViewPx.y * 2.0, 0.0, 1.0);
  vUv = aCorner;
  vSizePx = vec2(abs(xB - xA), yB - yT);
  vClamped = step(uMaxCellPx, aSats * uPxPerSat);
  vYPx = py;

  // The order's real age: a fact (when it rested) against the frame's clock.
  // Both come from the worker; the shader only subtracts.
  float aAge = max(uNowSec - aRestedAtSec, 0.0);
  vec3 base = aFlags > 0.5 ? LIQ : mix(BID, ASK, aSide);
  // Waiting made visible: arrive bright, settle by ~8s, dim to ember by
  // ~10min. Envelopes unchanged; they now travel the per-side hue anchors
  // (liquidation keeps neutral anchors so violet stays violet).
  vec3 hot = aFlags > 0.5 ? vec3(1.0) : mix(BID_HOT, ASK_HOT, aSide);
  vec3 emberC = aFlags > 0.5 ? LIQ * 0.4 : mix(BID_EMBER, ASK_EMBER, aSide);
  float settle = clamp(aAge / 8.0, 0.0, 1.0);
  float ember = clamp((aAge - 60.0) / 540.0, 0.0, 1.0);
  float flare = (uReduced > 0.5 ? 0.1 : 0.28) * (1.0 - settle);
  vec3 color = mix(mix(base, emberC, ember), hot, flare);
  float alpha = 0.92;
  if (uReduced < 0.5) alpha *= clamp(aAge / 0.12, 0.3, 1.0);
  vColor = vec4(color * (1.0 - uDim * 0.55), alpha);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in vec2 vUv;
in vec2 vSizePx;
in float vClamped;
in float vYPx;
// Chrome exclusion bands (px from top / from bottom): the picture plane
// resolves to zero before the control band and the provenance line — a deep
// row sheared by the viewport edge over the disclosure text reads as a bug,
// and the disclosure must never be overprinted.
uniform vec2 uBandPx;
uniform float uViewHPx;
// highp to match the vertex stage's declaration — ESSL requires a shared
// uniform to carry the same precision in both stages, and this FS defaults
// to mediump.
uniform highp float uDpr;
out vec4 outColor;
void main() {
  // Edge anti-aliasing measured in DEVICE pixels (~0.8), not CSS pixels: a
  // CSS-pixel feather is dpr× device pixels wide, and on a 3x phone that
  // 2.4-device-px ramp made every box read faintly blurred. One snapped
  // device pixel of ramp is the sharpest an edge can be without shimmer.
  // No alpha floor — the old 0.25 floor terminated every cell in a quarter-
  // strength ledge that read as a stroke.
  vec2 edgePx = min(vUv, 1.0 - vUv) * vSizePx;
  float feather = clamp(min(edgePx.x, edgePx.y) * uDpr / 0.8, 0.0, 1.0);
  // Luminous core: bright spine, darker skin — resting liquidity as lit
  // material, not flat paint. Mix toward white for the core, multiply DOWN
  // for the skin (never multiply >1 — clips amber to yellow-green). Rows
  // under ~3px keep today's exact flat color so the honest deep-zoom
  // L3→L2 melt is untouched.
  float profileOn = smoothstep(2.0, 3.0, vSizePx.y);
  float ny = abs(vUv.y - 0.5) * 2.0;
  float coreW = 1.0 - ny * ny;
  vec3 lit = mix(vColor.rgb * 0.80, mix(vColor.rgb, vec3(1.0), 0.16), coreW);
  vec3 c = mix(vColor.rgb, lit, profileOn);
  // Clamped whales fade over their far 18%: the length cap becomes legible
  // ("continues beyond what is drawn") and the largest flat field stops
  // dominating the frame's luminance budget. Unclamped cells are identical.
  float tail = 1.0 - vClamped * smoothstep(0.82, 1.0, vUv.x) * 0.55;
  float band = smoothstep(uBandPx.x - 26.0, uBandPx.x, vYPx) *
               (1.0 - smoothstep(uViewHPx - uBandPx.y - 26.0, uViewHPx - uBandPx.y, vYPx));
  outColor = vec4(c, vColor.a * feather * tail * band);
}`;

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
  /** Screen y of the center tick (spine puts it at the optical center). */
  centerYPx: number;
  dpr: number;
  /** The frame's pack-time clock (worker epoch); the shader turns it and each
   * order's restedAtSec into age. */
  nowSec: number;
  /** Chrome exclusion: px from the top / bottom edge inside which the field
   * fades to zero (control band, provenance line). */
  bandTopPx: number;
  bandBottomPx: number;
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
      "uCenterYPx", "uDpr", "uBandPx", "uViewHPx", "uNowSec",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  /** `upload` false re-draws the instance data already on the GPU — the same
   * worker frame seen again, with only the camera moved under it. The live
   * book is 8,768 orders, so that is a 210KB upload skipped. */
  draw(frame: Float32Array, instances: number, u: CellUniforms, upload = true): void {
    const gl = this.gl;
    if (instances === 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (upload) {
      const bytes = (FRAME_HEADER_FLOATS + instances * FRAME_STRIDE) * 4;
      if (bytes > this.capacityBytes) {
        gl.bufferData(gl.ARRAY_BUFFER, frame.byteLength, gl.DYNAMIC_DRAW);
        this.capacityBytes = frame.byteLength;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame, 0, FRAME_HEADER_FLOATS + instances * FRAME_STRIDE);
    }
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
    gl.uniform1f(this.uniforms.uCenterYPx, u.centerYPx);
    gl.uniform1f(this.uniforms.uDpr, u.dpr);
    gl.uniform1f(this.uniforms.uNowSec, u.nowSec);
    gl.uniform2f(this.uniforms.uBandPx, u.bandTopPx, u.bandBottomPx);
    gl.uniform1f(this.uniforms.uViewHPx, u.viewH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
    gl.bindVertexArray(null);
  }
}
