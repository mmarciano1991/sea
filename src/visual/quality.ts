/**
 * Adaptive render resolution. Starts from a pixel budget suited to the device
 * class, then steps resolution down (never up, to avoid oscillating) if
 * frames during active play are consistently slow. The surface is soft and
 * low-frequency, so a lower render scale costs very little visually.
 */

const DESKTOP_BUDGET = 2.8e6;
const TOUCH_BUDGET = 1.15e6;
const SLOW_FRAME_MS = 22;
const WINDOW = 40;
const MIN_SCALE = 0.55;
const COOLDOWN_MS = 2500;

export class QualityGovernor {
  private scale = 1;
  private samples: number[] = [];
  private cooldownUntil = 0;
  private readonly budget: number;

  constructor() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.budget = coarse ? TOUCH_BUDGET : DESKTOP_BUDGET;
  }

  pixelRatio(cssWidth: number, cssHeight: number): number {
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.sqrt(this.budget / Math.max(1, cssWidth * cssHeight));
    return Math.max(Math.min(dpr, 2, fit) * this.scale, 0.5);
  }

  /** Feed the duration of a frame rendered during active play. Returns true when the scale changed. */
  observe(frameMs: number, now: number): boolean {
    this.samples.push(frameMs);
    if (this.samples.length < WINDOW) return false;
    const sorted = this.samples.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.samples = [];
    if (median > SLOW_FRAME_MS && this.scale > MIN_SCALE && now > this.cooldownUntil) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.82);
      this.cooldownUntil = now + COOLDOWN_MS;
      return true;
    }
    return false;
  }
}
