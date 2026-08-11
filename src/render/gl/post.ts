import { createProgram } from "./context";

/**
 * Full-screen passes:
 *
 * - ROOM: a static radial lift behind everything — the field reads as a lit
 *   space instead of a dead buffer. Zero motion, dithered against OLED
 *   banding; truth-legal the same way the vignette is.
 * - MEMBRANE: a faint luminous band inside the spread gap, whose height IS
 *   the spread — the market's breathing, made barely visible. Data-driven
 *   height; the core+halo profile and temperature are presentation.
 * - VIGNETTE: a static darkening toward the edges; not motion, just a room.
 *
 * (A whole-field phosphor FADE pass shipped briefly and was removed: at real
 * OLED contrast it read as afterimage smearing. Decay belongs to discrete
 * event sprites, never to the field.)
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
uniform vec4 uColor;      // alpha channel carries the pass strength
uniform vec2 uViewPx;
uniform float uMidYPx;
uniform float uHalfHPx;   // membrane half-height (spread/2 in px, clamped)
uniform float uSeamXPx;
uniform float uFalloff;   // membrane horizontal gaussian width
uniform float uEdgeWin;   // 1 = force the band to true zero before the edge
uniform vec2 uShape;      // vignette ellipse shape (spine weights top/bottom)
out vec4 outColor;

// 1-LSB hash dither: near-black gradients band on 8-bit OLED without it.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  if (uMode == 0) {
    outColor = uColor;                       // flat wash (mode transitions)
  } else if (uMode == 1) {
    // The membrane: light escaping the seam between the two liquidity
    // fields. Core+halo so there is a highlight to catch the eye, not one
    // wide smear; temperature borrowed from the sides it separates (warm
    // toward the asks above, cool toward the bids below — no third hue).
    // px.y is top-down to match tickToY's convention (vUv.y is bottom-up:
    // the fullscreen triangle lives in clip space) — with the spine's
    // off-center mid, a flipped y draws the band mirrored about center.
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uViewPx;
    float dy = (px.y - uMidYPx) / max(uHalfHPx, 2.0);
    float dx = abs(px.x - uSeamXPx) / (uViewPx.x * 0.5);
    float core = exp(-dy * dy * 3.0);
    float halo = exp(-dy * dy * 0.35);
    float band = (0.7 * core + 0.3 * halo) * exp(-dx * dx * uFalloff);
    // Seam layout: die to true zero well before the frame edge — a 1-LSB
    // edge-to-edge tint reads as screen grime. The spine's band is meant to
    // span the full-width rows, so it skips the window (dither covers it).
    band *= mix(1.0, smoothstep(0.95, 0.45, dx), uEdgeWin);
    vec3 warm = vec3(0.98, 0.82, 0.60);
    vec3 cool = vec3(0.50, 0.72, 0.95);
    vec3 glow = mix(cool, warm,
      clamp(0.5 + (uMidYPx - px.y) / max(uHalfHPx * 4.0, 8.0), 0.0, 1.0));
    float a = band * uColor.a;
    a = max(a + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 0.0);
    outColor = vec4(glow * a, a);            // premultiplied additive
  } else if (uMode == 2) {
    // Vignette: aspect-corrected so the falloff is circular on any frame
    // (raw UV distance squashed it on wide desktops), ellipse-shaped on the
    // spine so periphery whale rows yield to the touch.
    vec2 q = (vUv - 0.5) * vec2(uViewPx.x / uViewPx.y, 1.0) * uShape;
    float d = length(q);
    float v = smoothstep(0.35, 1.05, d) * uColor.a;
    outColor = vec4(vec3(1.0 - v), 1.0);     // multiplicative darkening
  } else {
    // The room: #0E141B at center easing to #080B0F at the corners. Static.
    vec2 q = (vUv - 0.5) * vec2(uViewPx.x / uViewPx.y, 1.0);
    float d = length(q);
    vec3 bg = mix(vec3(0.055, 0.078, 0.106), vec3(0.031, 0.043, 0.059),
      smoothstep(0.15, 0.9, d));
    outColor = vec4(bg + vec3((hash(gl_FragCoord.xy) - 0.5) / 255.0), 1.0);
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
      "uMode", "uColor", "uViewPx", "uMidYPx", "uHalfHPx", "uSeamXPx",
      "uFalloff", "uEdgeWin", "uShape",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  private draw(mode: number, color: [number, number, number, number], extra?: {
    viewW: number; viewH: number; midY?: number; halfH?: number; seamX?: number;
    falloff?: number; edgeWin?: number; shapeX?: number; shapeY?: number;
  }): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform4f(this.u.uColor, ...color);
    if (extra) {
      gl.uniform2f(this.u.uViewPx, extra.viewW, extra.viewH);
      gl.uniform1f(this.u.uMidYPx, extra.midY ?? 0);
      gl.uniform1f(this.u.uHalfHPx, extra.halfH ?? 0);
      gl.uniform1f(this.u.uSeamXPx, extra.seamX ?? 0);
      gl.uniform1f(this.u.uFalloff, extra.falloff ?? 2.2);
      gl.uniform1f(this.u.uEdgeWin, extra.edgeWin ?? 1);
      gl.uniform2f(this.u.uShape, extra.shapeX ?? 1, extra.shapeY ?? 1);
    }
    gl.enable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Static background lift; overwrites, so call right after clear. */
  room(viewW: number, viewH: number): void {
    this.gl.blendFunc(this.gl.ONE, this.gl.ZERO);
    this.draw(3, [0, 0, 0, 1], { viewW, viewH });
  }

  membrane(
    viewW: number, viewH: number, midY: number, halfH: number, seamX: number,
    alpha: number, falloff: number, edgeWin: number,
  ): void {
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    this.draw(1, [0, 0, 0, alpha], { viewW, viewH, midY, halfH, seamX, falloff, edgeWin });
  }

  vignette(strength: number, viewW: number, viewH: number, shapeX: number, shapeY: number): void {
    this.gl.blendFunc(this.gl.ZERO, this.gl.SRC_COLOR);
    this.draw(2, [0, 0, 0, strength], { viewW, viewH, shapeX, shapeY });
  }
}
