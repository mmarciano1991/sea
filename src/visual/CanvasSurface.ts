import { CONTACT_STRIDE, MAX_CONTACTS } from '../physics/Membrane';
import { sampleDotWaves } from './DotWaves';
import { linearToSrgb, type RGB } from './palette';
import {
  DOT_JITTER,
  DOT_OPACITY,
  GRID_DASH,
  GRID_EDGE_FADE,
  GRID_GAP,
  GRID_OPACITY,
  SHARPS,
  displace,
  dotEdgeFade,
  dotFade,
  dotGrid,
  dotJitter,
} from './surfaceMath';
import type { SurfaceFrame, SurfaceRenderer } from './surface';

/**
 * Canvas 2D fallback for devices without WebGL. It keeps the essentials of the
 * experience — the single tone colour, a shaded indentation, and a dot mesh that is
 * displaced and fades with the same physics — at a fraction of the fidelity.
 */
/** The CPU draws every dot itself, so the fallback mesh is a little coarser. */
const COARSEN = 1.6;

const css = (c: RGB) =>
  `rgb(${linearToSrgb(c[0]) * 255}, ${linearToSrgb(c[1]) * 255}, ${linearToSrgb(c[2]) * 255})`;

export class CanvasSurface implements SurfaceRenderer {
  readonly kind = 'canvas';
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dot = document.createElement('canvas');
  private readonly offset: [number, number] = [0, 0];
  private readonly shiver: [number, number] = [0, 0];
  private readonly ripple: [number, number] = [0, 0];
  private gridFade: CanvasGradient | null = null;
  private gridFadeHeight = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private scale = 1;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D canvas context available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.scale = Math.min(pixelRatio, 2);
    this.canvas.width = Math.round(this.cssWidth * this.scale);
    this.canvas.height = Math.round(this.cssHeight * this.scale);
    this.paintDot();
  }

  render(frame: SurfaceFrame): void {
    const { ctx, scale } = this;
    const { contacts, liveContacts } = frame;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(frame.tone);
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    for (let i = 0; i < MAX_CONTACTS; i++) {
      const o = i * CONTACT_STRIDE;
      const depth = contacts[o + 2];
      if (Math.abs(depth) < 1e-3) continue;
      const x = contacts[o];
      const y = contacts[o + 1];
      const a = contacts[o + 3];
      const d = Math.max(depth, 0);
      // Shadow on the near wall (light comes from the upper left), light on the far wall.
      const shadow = ctx.createRadialGradient(x - a * 0.3, y - a * 0.35, 0, x, y, a * 2.4);
      shadow.addColorStop(0, `rgba(0,0,0,${0.24 * d})`);
      shadow.addColorStop(0.45, `rgba(0,0,0,${0.1 * d})`);
      shadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadow;
      ctx.fillRect(x - a * 3, y - a * 3, a * 6, a * 6);
      const light = ctx.createRadialGradient(x + a * 0.5, y + a * 0.6, 0, x + a * 0.5, y + a * 0.6, a * 1.3);
      light.addColorStop(0, `rgba(255,255,255,${0.07 * d})`);
      light.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = light;
      ctx.fillRect(x - a * 1.5, y - a * 1.5, a * 4, a * 4);
    }

    const { spacing, radius } = dotGrid(this.cssWidth, this.cssHeight, COARSEN);
    const rowH = spacing * 0.8660254;
    const cx = this.cssWidth / 2;
    const cy = this.cssHeight / 2;
    const rows = Math.ceil(cy / rowH) + 1;
    const cols = Math.ceil(cx / spacing) + 1;
    const size = radius * 2 + 2;
    // On the white membrane the dots are a soft grey ink; on colour they are white.
    const ink = this.dot;
    ctx.filter = frame.paleness > 0.01 ? `brightness(${1 - 0.45 * frame.paleness})` : 'none';
    for (let row = -rows; row <= rows; row++) {
      const offset = (row & 1) * 0.5 * spacing;
      const my = cy + row * rowH;
      for (let col = -cols; col <= cols; col++) {
        const mx = cx + col * spacing + offset;
        dotJitter(col, row, frame.time, this.shiver);
        let alpha = DOT_OPACITY * sampleDotWaves(frame.waves, mx - cx, my - cy, col, row, spacing, this.ripple);
        let px = mx + this.shiver[0] * spacing * DOT_JITTER + this.ripple[0];
        let py = my + this.shiver[1] * spacing * DOT_JITTER + this.ripple[1];
        if (liveContacts > 0) {
          displace(contacts, liveContacts, mx, my, this.offset);
          px += this.offset[0];
          py += this.offset[1];
          alpha *= 1 - dotFade(contacts, liveContacts, mx, my);
          if (alpha < 0.01) continue;
        }
        alpha *= dotEdgeFade(px / this.cssWidth);
        if (alpha < 0.01) continue;
        ctx.globalAlpha = alpha;
        ctx.drawImage(ink, px - size / 2, py - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.filter = 'none';

    // Note grid: a 1 px line on every semitone, sharps dashed, fading out top and bottom.
    if (frame.grid > 0.001) {
      if (!this.gridFade || this.gridFadeHeight !== this.cssHeight) {
        const h = this.cssHeight;
        this.gridFade = ctx.createLinearGradient(0, 0, 0, h);
        this.gridFadeHeight = h;
        this.gridFade.addColorStop(0, 'rgba(255,255,255,0)');
        this.gridFade.addColorStop(GRID_EDGE_FADE, 'rgba(255,255,255,1)');
        this.gridFade.addColorStop(1 - GRID_EDGE_FADE, 'rgba(255,255,255,1)');
        this.gridFade.addColorStop(1, 'rgba(255,255,255,0)');
      }
      ctx.save();
      ctx.globalAlpha = GRID_OPACITY * frame.grid;
      ctx.strokeStyle = this.gridFade;
      if (frame.paleness > 0.5) ctx.filter = 'brightness(0.35)';
      ctx.lineWidth = 1 / scale;
      for (let k = 0; k <= 12; k++) {
        const x = Math.min(Math.max((k * this.cssWidth) / 12, 0.5 / scale), this.cssWidth - 0.5 / scale);
        ctx.setLineDash(SHARPS.has(k % 12) ? [GRID_DASH, GRID_GAP] : []);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.cssHeight);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  dispose(): void {
    this.dot.width = this.dot.height = 0;
  }

  private paintDot(): void {
    const { radius } = dotGrid(this.cssWidth, this.cssHeight, COARSEN);
    const size = radius * 2 + 2;
    const px = Math.ceil(size * this.scale);
    this.dot.width = this.dot.height = px;
    const dctx = this.dot.getContext('2d');
    if (!dctx) return;
    dctx.fillStyle = '#fff';
    dctx.beginPath();
    dctx.arc(px / 2, px / 2, radius * this.scale, 0, Math.PI * 2);
    dctx.fill();
  }
}
