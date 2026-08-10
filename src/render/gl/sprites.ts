import { cornerBuffer, createProgram } from "./context";

/**
 * Event sprites: the decays of instantaneous market events. A trade IS an
 * instant; only its afterglow is animated (the brief's rule, verbatim). Three
 * kinds: trade flash (hot, additive), cancel ghost (a cool sigh where a
 * quote died), and the reduced-motion ring (a slow, still marker that
 * replaces the flash when motion must be gentle).
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
void main() {
  float grow = aKind == 2.0 ? (0.4 + aAge * 1.2) : (aKind == 0.0 ? (0.7 + aAge * 0.9) : 1.0);
  vec2 corner = (aCorner - 0.5) * aSize * 2.2 * grow;
  vec2 px = aPos + corner;
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
  float r = length(vLocal) * 2.0;
  vec3 tint = vTint > 1.5 ? LIQ : mix(BID, ASK, vTint);
  float fade = 1.0 - vAge;
  vec3 color; float a;
  if (vKind == 0.0) {
    // Trade flash: white-hot core cooling into the side's hue.
    float core = smoothstep(1.0, 0.0, r);
    color = mix(tint, vec3(1.0), core * fade * 0.8);
    a = core * fade * fade;
  } else if (vKind == 1.0) {
    // Cancel ghost: a faint puff where a quote died — small, brief, cool.
    float puff = smoothstep(0.9, 0.0, r);
    color = tint;
    a = puff * fade * 0.16;
  } else {
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
