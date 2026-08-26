import { createProgram } from "./context";

/**
 * BACKDROP: room gradient and vignette combined into ONE opaque fullscreen
 * draw that also replaces the clear — what would be a clear plus two blended
 * fullscreen passes is a single unblended write, which matters at 3x phone
 * resolution. Static by design: a lit room, no motion.
 *
 * (Lineage, all owner-verified on hardware: a phosphor FADE pass — removed,
 * afterimage smearing; a luminous spread MEMBRANE — removed, the owner
 * wants no glow behind the field at all. Nothing decays over the field any
 * more either; light belongs to the cells themselves.)
 */

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uViewPx;
uniform vec2 uShape;      // vignette ellipse shape (spine weights top/bottom)
uniform float uVignette;
out vec4 outColor;

// 1-LSB hash dither: near-black gradients band on 8-bit OLED without it.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // #0E141B at center easing to #080B0F at the corners, vignette folded into
  // the same radial term. One opaque write.
  vec2 q = (vUv - 0.5) * vec2(uViewPx.x / uViewPx.y, 1.0);
  float d = length(q);
  vec3 bg = mix(vec3(0.055, 0.078, 0.106), vec3(0.031, 0.043, 0.059),
    smoothstep(0.15, 0.9, d));
  float v = smoothstep(0.35, 1.05, length(q * uShape)) * uVignette;
  outColor = vec4(bg * (1.0 - v) + vec3((hash(gl_FragCoord.xy) - 0.5) / 255.0), 1.0);
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
    for (const name of ["uViewPx", "uShape", "uVignette"]) {
      this.u[name] = gl.getUniformLocation(this.program, name)!;
    }
  }

  /** Opaque room + vignette; replaces the frame clear entirely. */
  backdrop(viewW: number, viewH: number, vignette: number, shapeX: number, shapeY: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uViewPx, viewW, viewH);
    gl.uniform1f(this.u.uVignette, vignette);
    gl.uniform2f(this.u.uShape, shapeX, shapeY);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
