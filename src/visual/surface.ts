import { CanvasSurface } from './CanvasSurface';
import { WebGLSurface } from './WebGLSurface';

import type { RGB } from './palette';

export interface SurfaceFrame {
  /** Seconds, for the idle swell. */
  time: number;
  /** Packed contact state (see Membrane.pack). */
  contacts: Float32Array;
  /** Number of live contacts. */
  liveContacts: number;
  /** The membrane's single current colour, linear sRGB. */
  tone: RGB;
  /** 0 on colour … 1 on the white resting membrane (dots switch to grey ink). */
  paleness: number;
  /** Travelling disturbances of the dot mesh (see DotWaves.pack). */
  waves: Float32Array;
  /** Note grid visibility, 0…1. */
  grid: number;
}

export interface SurfaceRenderer {
  readonly kind: 'webgl' | 'canvas';
  readonly canvas: HTMLCanvasElement;
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  render(frame: SurfaceFrame): void;
  dispose(): void;
}

/**
 * Creates the best available renderer inside `host`. WebGL is probed on its own
 * canvas; if that fails at any point the canvas is discarded and a fresh one
 * gets the Canvas 2D fallback (a canvas can only ever hold one context type).
 */
export function createSurface(host: HTMLElement): SurfaceRenderer {
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    return canvas;
  };

  const glCanvas = make();
  try {
    const surface = WebGLSurface.create(glCanvas);
    if (surface) return surface;
  } catch (error) {
    console.warn('[sea] WebGL unavailable, using canvas fallback', error);
  }
  glCanvas.remove();
  return new CanvasSurface(make());
}
