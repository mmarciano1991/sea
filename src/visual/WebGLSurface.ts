import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';
import { dotGrid } from './surfaceMath';
import type { SurfaceFrame, SurfaceRenderer } from './surface';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const UNIFORMS = [
  'u_view',
  'u_canvasHeight',
  'u_pxScale',
  'u_time',
  'u_active',
  'u_dotSpacing',
  'u_dotRadius',
  'u_contacts',
  'u_tone',
  'u_paleness',
  'u_waves',
  'u_grid',
] as const;
type UniformName = (typeof UNIFORMS)[number];

export class WebGLSurface implements SurfaceRenderer {
  readonly kind = 'webgl';
  readonly canvas: HTMLCanvasElement;
  private readonly gl: GL;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
  private lost = false;

  private cssWidth = 1;
  private cssHeight = 1;
  private pxScale = 1;

  static create(canvas: HTMLCanvasElement): WebGLSurface | null {
    const options: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    };
    const gl = (canvas.getContext('webgl2', options) ?? canvas.getContext('webgl', options)) as GL | null;
    if (!gl) return null;
    return new WebGLSurface(canvas, gl);
  }

  private constructor(canvas: HTMLCanvasElement, gl: GL) {
    this.canvas = canvas;
    this.gl = gl;
    this.init();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    const width = Math.max(1, Math.round(this.cssWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.cssHeight * pixelRatio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.pxScale = width / this.cssWidth;
  }

  render(frame: SurfaceFrame): void {
    const { gl, program } = this;
    if (this.lost || !program || gl.isContextLost()) return;
    const u = this.uniforms;
    const grid = dotGrid(this.cssWidth, this.cssHeight);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(program);
    gl.uniform2f(u.u_view, this.cssWidth, this.cssHeight);
    gl.uniform1f(u.u_canvasHeight, this.canvas.height);
    gl.uniform1f(u.u_pxScale, this.pxScale);
    gl.uniform1f(u.u_time, frame.time);
    gl.uniform1f(u.u_active, frame.liveContacts > 0 ? 1 : 0);
    gl.uniform1f(u.u_dotSpacing, grid.spacing);
    gl.uniform1f(u.u_dotRadius, grid.radius);
    gl.uniform4fv(u.u_contacts, frame.contacts);
    gl.uniform3f(u.u_tone, frame.tone[0], frame.tone[1], frame.tone[2]);
    gl.uniform1f(u.u_paleness, frame.paleness);
    gl.uniform4fv(u.u_waves, frame.waves);
    gl.uniform1f(u.u_grid, frame.grid);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const { gl } = this;
    if (!gl.isContextLost()) {
      gl.deleteProgram(this.program);
      gl.deleteBuffer(this.buffer);
    }
    this.program = null;
    this.buffer = null;
  }

  private init(): void {
    const { gl } = this;
    const program = gl.createProgram();
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!program) throw new Error('Could not create WebGL program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }

    // One oversized triangle covers the viewport without a diagonal seam.
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.program = program;
  }

  private compile(type: number, source: string): WebGLShader {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
  }

  private onLost = (event: Event): void => {
    event.preventDefault(); // allow restoration
    this.lost = true;
    this.program = null;
    this.buffer = null;
  };

  private onRestored = (): void => {
    try {
      this.init();
      this.lost = false;
    } catch (error) {
      console.error('[sea] could not restore WebGL', error);
    }
  };
}
