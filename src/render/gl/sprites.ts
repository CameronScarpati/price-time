import { cornerBuffer, createProgram } from "./context";

/**
 * Event sprites: the decays of instantaneous market events. A trade IS an
 * instant; only its afterglow is animated (the brief's rule, verbatim).
 * Three kinds: trade BITE (the exact rectangular span of book the trade
 * removed, flashing white-hot in place and cooling into the maker side's
 * hue — anchored to the bar it bit, never floating in space), cancel ghost
 * (a cool sigh where a quote died), and the reduced-motion ring (a slow,
 * still marker replacing the bite when motion must be gentle).
 *
 * The bite replaced a soft elliptical strike at the queue front: caught
 * mid-decay — or left behind after the price moved — the ellipse read as a
 * dirty smudge hanging in empty space (owner-verified on hardware). A
 * rectangle in the row's own geometry is a bar briefly remembering its
 * lost span; it cannot read as dirt.
 *
 * Encoding note: a sprite's direction (into the consumed side) rides the
 * SIGN of its size field — negative size extends left.
 */

export const SpriteKind = { Bite: 0, Ghost: 1, Ring: 2 } as const;

export interface Sprite {
  xPx: number;
  yPx: number;
  /** Bite: signed span width. Ghost/Ring: footprint size. */
  sizePx: number;
  /** Bite row height in px; unused by ghost/ring. */
  hPx: number;
  /** 0 = born, 1 = gone. Advanced by the renderer's presentation clock. */
  age01: number;
  kind: (typeof SpriteKind)[keyof typeof SpriteKind];
  /** 0 bid-colored, 1 ask-colored, 2 liquidation. */
  tint: number;
  /** Stagger: sprites within one burst start at spaced offsets. */
  delayMs: number;
  bornMs: number;
  lifeMs: number;
}

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aPos;
layout(location=2) in float aSize;
layout(location=3) in float aH;
layout(location=4) in float aAge;
layout(location=5) in float aKind;
layout(location=6) in float aTint;
uniform vec2 uViewPx;
out vec2 vLocal;
out float vAge;
out float vKind;
out float vTint;
void main() {
  float size = abs(aSize);
  float dir = aSize < 0.0 ? -1.0 : 1.0;
  vec2 corner;
  vec2 center = aPos;
  if (aKind == 0.0) {
    // Bite: a row-shaped quad over the vanished span. aPos.x is the span's
    // inner edge; the quad extends outward in the consumed direction.
    corner = (aCorner - 0.5) * vec2(size, aH);
    center.x += dir * size * 0.5;
  } else {
    float grow = aKind == 2.0 ? (0.4 + aAge * 1.2) : 1.0;
    corner = (aCorner - 0.5) * size * 2.2 * grow;
  }
  vec2 px = center + corner;
  gl_Position = vec4(px.x / uViewPx.x * 2.0 - 1.0, 1.0 - px.y / uViewPx.y * 2.0, 0.0, 1.0);
  vLocal = aCorner - 0.5;
  vAge = aAge;
  vKind = aKind;
  vTint = aTint;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vLocal;
in float vAge;
in float vKind;
in float vTint;
out vec4 outColor;
const vec3 BID = vec3(0.263, 0.686, 0.961);
const vec3 ASK = vec3(1.0, 0.667, 0.278);
const vec3 LIQ = vec3(0.71, 0.49, 1.0);
void main() {
  vec3 tint = vTint > 1.5 ? LIQ : mix(BID, ASK, vTint);
  float fade = 1.0 - vAge;
  vec3 color; float a;
  if (vKind == 0.0) {
    // Bite: sharp-edged like the bars themselves — a soft round glow here
    // reads as a smudge, hard-learned. White-hot at birth, cooling into
    // the side hue, gone completely; fade² ends decisively, no dull tail.
    vec2 d = (0.5 - abs(vLocal)) * 2.0;
    float rect = smoothstep(0.0, 0.10, min(d.x, d.y));
    float attack = smoothstep(0.0, 0.12, vAge);
    float decay = fade * fade;
    color = mix(tint, vec3(1.0), 0.75 * decay);
    a = rect * attack * decay * 0.85;
  } else if (vKind == 1.0) {
    // Cancel ghost: a row-aligned sliver where a quote died — the shape of
    // the cell that vanished. Brief and faint: it must never read as an
    // afterimage, only as the eye's chance to notice the loss.
    float r = length(vec2(vLocal.x, vLocal.y * 3.4)) * 2.0;
    float puff = smoothstep(0.72, 0.10, r);
    color = tint;
    a = puff * fade * 0.08;
  } else {
    float r = length(vLocal) * 2.0;
    // Reduced-motion ring: a quiet annulus, no growth spike, long fade.
    float ring = smoothstep(0.12, 0.0, abs(r - (0.4 + vAge * 0.5)));
    color = mix(tint, vec3(1.0), 0.3);
    a = ring * fade * 0.5;
  }
  outColor = vec4(color * a, a);
}`;

const FLOATS_PER_SPRITE = 7;
const MAX_SPRITES = 512;

export class SpritePipeline {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly scratch = new Float32Array(MAX_SPRITES * FLOATS_PER_SPRITE);
  private readonly uViewPx: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VS, FS);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_SPRITE * 4;
    const layout: [number, number, number][] = [
      [1, 2, 0], [2, 1, 8], [3, 1, 12], [4, 1, 16], [5, 1, 20], [6, 1, 24],
    ];
    for (const [loc, size, offset] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    this.uViewPx = gl.getUniformLocation(this.program, "uViewPx")!;
  }

  draw(sprites: readonly Sprite[], viewW: number, viewH: number): void {
    const gl = this.gl;
    let n = 0;
    for (const s of sprites) {
      if (n >= MAX_SPRITES || s.age01 < 0) continue;
      const base = n * FLOATS_PER_SPRITE;
      this.scratch[base] = s.xPx;
      this.scratch[base + 1] = s.yPx;
      this.scratch[base + 2] = s.sizePx;
      this.scratch[base + 3] = s.hPx;
      this.scratch[base + 4] = s.age01;
      this.scratch[base + 5] = s.kind;
      this.scratch[base + 6] = s.tint;
      n++;
    }
    if (n === 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.scratch, 0, n * FLOATS_PER_SPRITE);
    gl.uniform2f(this.uViewPx, viewW, viewH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied additive glow
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }
}
