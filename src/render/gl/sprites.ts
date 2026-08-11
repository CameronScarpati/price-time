import { cornerBuffer, createProgram } from "./context";

/**
 * Event sprites: the decays of instantaneous market events. A trade IS an
 * instant; only its afterglow is animated (the brief's rule, verbatim).
 * Three kinds: trade HEAT STREAK (a warm wash that pools along the consumed
 * row and cools slowly — rapid trades sum into sustained warmth instead of
 * strobing), cancel ghost (a cool sigh where a quote died), and the
 * reduced-motion ring (a slow, still marker replacing the streak when motion
 * must be gentle).
 *
 * Encoding note: a streak's direction (into the consumed side) rides the
 * SIGN of its size field — negative size points left. It keeps the instance
 * layout at six floats.
 */

export const SpriteKind = { Flash: 0, Ghost: 1, Ring: 2 } as const;

export interface Sprite {
  xPx: number;
  yPx: number;
  sizePx: number;
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
layout(location=3) in float aAge;
layout(location=4) in float aKind;
layout(location=5) in float aTint;
uniform vec2 uViewPx;
out vec2 vLocal;
out float vAge;
out float vKind;
out float vTint;
out float vDir;
void main() {
  float size = abs(aSize);
  float dir = aSize < 0.0 ? -1.0 : 1.0;
  vec2 corner;
  vec2 center = aPos;
  if (aKind == 0.0) {
    // Heat streak: long and low, lying along the consumed row, anchored at
    // the strike point and reaching into the side that was eaten.
    corner = (aCorner - 0.5) * vec2(size * 5.0, size * 1.15);
    center.x += dir * size * 2.1;
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
  vDir = dir;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vLocal;
in float vAge;
in float vKind;
in float vTint;
in float vDir;
out vec4 outColor;
const vec3 BID = vec3(0.263, 0.686, 0.961);
const vec3 ASK = vec3(1.0, 0.667, 0.278);
const vec3 LIQ = vec3(0.71, 0.49, 1.0);
void main() {
  vec3 tint = vTint > 1.5 ? LIQ : mix(BID, ASK, vTint);
  float fade = 1.0 - vAge;
  vec3 color; float a;
  if (vKind == 0.0) {
    // Heat streak: fast attack, long exponential cool-down. Real heat: a
    // white-hot core at the strike point fringed in side-color at birth,
    // sinking toward ember (amber → burnt orange, blue → deep sea) as it
    // cools — same 950ms life, same envelope and position, only the
    // temperature curve. Overlapping burst streaks sum into sustained glow.
    float along = clamp(0.5 - vLocal.x * vDir, 0.0, 1.0);   // 1 at strike end
    float lateral = exp(-vLocal.y * vLocal.y * 14.0);
    float attack = smoothstep(0.0, 0.06, vAge);
    float cool = exp(-vAge * 3.2);
    float body = along * along * lateral;
    float heat = body * cool;
    vec3 deepC = vTint > 1.5 ? LIQ * 0.55
      : mix(vec3(0.05, 0.24, 0.46), vec3(0.55, 0.22, 0.05), vTint);
    vec3 c = mix(deepC, tint, cool);
    color = mix(c, vec3(1.0), heat * 0.75);
    a = body * attack * cool * 0.5;
  } else if (vKind == 1.0) {
    // Cancel ghost: a row-aligned sliver where a quote died — the shape of
    // the cell that vanished, never a floating out-of-focus blob.
    float r = length(vec2(vLocal.x, vLocal.y * 3.4)) * 2.0;
    float puff = smoothstep(0.72, 0.10, r);
    color = tint;
    a = puff * fade * 0.1;
  } else {
    float r = length(vLocal) * 2.0;
    // Reduced-motion ring: a quiet annulus, no growth spike, long fade.
    float ring = smoothstep(0.12, 0.0, abs(r - (0.4 + vAge * 0.5)));
    color = mix(tint, vec3(1.0), 0.3);
    a = ring * fade * 0.5;
  }
  outColor = vec4(color * a, a);
}`;

const FLOATS_PER_SPRITE = 6;
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
      [1, 2, 0], [2, 1, 8], [3, 1, 12], [4, 1, 16], [5, 1, 20],
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
      this.scratch[base + 3] = s.age01;
      this.scratch[base + 4] = s.kind;
      this.scratch[base + 5] = s.tint;
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
