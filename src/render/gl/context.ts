/** Minimal WebGL2 plumbing — two small pipelines don't justify a library. */

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}\n${src}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
  }
  return program;
}

/** The static unit-quad corner buffer shared by both instanced pipelines. */
export function cornerBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  return buffer;
}
