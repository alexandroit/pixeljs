import { PixelJSError } from '../../api/errors.js';
import type { RendererKind } from '../../api/types.js';
import { PROTOCOL } from '../../internal/protocol.js';
import type { WasmAdapter } from '../../internal/wasm/adapter.js';

/** Presents the C framebuffer. Palette changes become visible with the next
 * present(), in both backends, whichever operation changed them. */
export interface Renderer {
  readonly kind: RendererKind;
  present(): void;
  restore(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
class CanvasRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  private image: ImageData | null;
  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly core: WasmAdapter,
    width: number,
    height: number,
  ) {
    // A host-owned copy avoids retaining a heap view in ImageData across disposal.
    this.image = context.createImageData(width, height);
    context.imageSmoothingEnabled = false;
  }
  resize(width: number, height: number): void {
    this.image = this.context.createImageData(width, height);
    this.context.imageSmoothingEnabled = false;
  }
  present(): void {
    if (!this.image) throw new PixelJSError('STATE', 'Renderer has been disposed.');
    this.core.expand();
    this.image.data.set(this.core.rgba);
    this.context.putImageData(this.image, 0, 0);
  }
  restore(): void {
    this.context.imageSmoothingEnabled = false;
  }
  dispose(): void {
    this.image = null;
  }
}
class GLRenderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private program: WebGLProgram | null = null;
  private indices: WebGLTexture | null = null;
  private palette: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private paletteRevision = -1;
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly core: WasmAdapter,
    private width: number,
    private height: number,
  ) {
    try {
      this.restore();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new PixelJSError('RENDERER', 'Could not allocate a WebGL shader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new PixelJSError(
        'RENDERER',
        `WebGL shader compilation failed: ${log ?? 'unknown error'}`,
      );
    }
    return shader;
  }
  restore(): void {
    const gl = this.gl;
    this.dispose();
    let vertex: WebGLShader | null = null;
    let fragment: WebGLShader | null = null;
    try {
      vertex = this.shader(
        gl.VERTEX_SHADER,
        `#version 300 es
void main() {
  vec2 p[3] = vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
  gl_Position = vec4(p[gl_VertexID],0.,1.);
}`,
      );
      fragment = this.shader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uIndices;
uniform sampler2D uPalette;
uniform int uHeight;
out vec4 color;
void main() {
  ivec2 pixel = ivec2(int(gl_FragCoord.x),uHeight-1-int(gl_FragCoord.y));
  uint index = texelFetch(uIndices,pixel,0).r;
  color = texelFetch(uPalette,ivec2(int(index),0),0);
}`,
      );
      this.program = gl.createProgram();
      if (!this.program) throw new PixelJSError('RENDERER', 'Could not allocate a WebGL program.');
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new PixelJSError('RENDERER', 'WebGL program linking failed.');
      this.vao = gl.createVertexArray();
      this.indices = gl.createTexture();
      this.palette = gl.createTexture();
      if (!this.vao || !this.indices || !this.palette)
        throw new PixelJSError('RENDERER', 'Could not allocate WebGL presentation resources.');
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uIndices'), 0);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uPalette'), 1);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uHeight'), this.height);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.bindTexture(0, this.indices);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8UI,
        this.width,
        this.height,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        this.core.indexed,
      );
      // Every index is below 256, so the lookup never samples outside the texture.
      this.bindTexture(1, this.palette);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        PROTOCOL.maxPaletteColors,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.core.palette,
      );
      this.paletteRevision = this.core.paletteRevision;
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      if (gl.getError() !== gl.NO_ERROR)
        throw new PixelJSError('RENDERER', 'WebGL texture setup failed.');
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }
  private bindTexture(unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  present(): void {
    const gl = this.gl;
    if (!this.program || !this.indices || !this.palette || !this.vao)
      throw new PixelJSError('STATE', 'Renderer is unavailable.');
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.indices);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      this.core.indexed,
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    const revision = this.core.paletteRevision;
    if (revision !== this.paletteRevision) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        PROTOCOL.maxPaletteColors,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.core.palette,
      );
      this.paletteRevision = revision;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  resize(width: number, height: number): void {
    const gl = this.gl;
    // Restoration after a lost context rebuilds textures from these values.
    this.width = width;
    this.height = height;
    if (gl.isContextLost() || !this.program || !this.indices || !this.vao) return;
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uHeight'), this.height);
    this.bindTexture(0, this.indices);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      this.width,
      this.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      this.core.indexed,
    );
    gl.viewport(0, 0, this.width, this.height);
    if (gl.getError() === gl.OUT_OF_MEMORY)
      throw new PixelJSError('RENDERER', 'WebGL could not allocate the resized frame texture.');
  }
  dispose(): void {
    const gl = this.gl;
    // Context loss invalidates old objects. Never delete handles from the previous context generation.
    if (this.program && gl.isProgram(this.program)) gl.deleteProgram(this.program);
    if (this.indices && gl.isTexture(this.indices)) gl.deleteTexture(this.indices);
    if (this.palette && gl.isTexture(this.palette)) gl.deleteTexture(this.palette);
    if (this.vao && gl.isVertexArray(this.vao)) gl.deleteVertexArray(this.vao);
    this.program = null;
    this.indices = null;
    this.palette = null;
    this.vao = null;
  }
}
export function createRenderer(
  canvas: HTMLCanvasElement,
  core: WasmAdapter,
  kind: 'auto' | RendererKind,
  width: number,
  height: number,
): Renderer {
  canvas.width = width;
  canvas.height = height;
  if (kind !== 'canvas2d') {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (gl) return new GLRenderer(gl, core, width, height);
    if (kind === 'webgl2')
      throw new PixelJSError('UNSUPPORTED', 'WebGL2 is unavailable for this canvas.');
  }
  const context = canvas.getContext('2d', { alpha: false });
  if (!context)
    throw new PixelJSError(
      'UNSUPPORTED',
      'Canvas2D is unavailable. Use a canvas without an existing incompatible context.',
    );
  return new CanvasRenderer(context, core, width, height);
}
