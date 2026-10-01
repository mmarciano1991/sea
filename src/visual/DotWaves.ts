/**
 * Ripples through the dot mesh, like a fingertip touching still water just
 * beyond the edge of the screen.
 *
 * Ambient waves start at a random point just outside one randomly chosen edge
 * (top, bottom, left or right) and expand across the surface as a circular
 * ring. Touching the surface sends the same kind of ripple out from the
 * fingertip, so the mesh answers the player exactly as it answers the world.
 *
 * A moving finger leaves a wake: small rings dropped along its path, spaced by
 * distance travelled, each expanding and fading within a second — together
 * they trail the finger's actual route and direction, as a fingertip drawn
 * through calm water does. Faster movement makes stronger rings; a still
 * finger makes none. The ring is a soft packet — short leading edge, strong centre, long
 * gradual falloff behind — carrying a gentle oscillation that moves each dot
 * along the ripple plus a little in its own random direction, and lifts its
 * opacity. Strength eases off as the ring spreads, as real ripples do.
 *
 * The effect is a pure function of the waves' current state: nothing
 * accumulates, so once a ring has passed, every dot is exactly back at its rest
 * position and opacity. Waves are purely a property of the dots — colour,
 * sound and membrane physics never read this state. Edge, position, speed,
 * width, wavelength, strength and timing are all randomised, and arrivals are
 * Poisson-like, so the mesh never settles into a loop.
 *
 * Packed per wave (2 × vec4), coordinates relative to the viewport centre in CSS px:
 *   [sourceX, sourceY, radius, strength] [wavelength, lead, tail, 0]
 * Ambient and touch ripples fill the first MAX_AMBIENT slots, the wake the rest.
 * A zero strength marks an empty slot.
 */

/** Edge and touch ripples. */
export const MAX_AMBIENT = 4;
/** Rings of the moving finger's wake. */
export const MAX_WAKE = 6;
export const MAX_WAVES = MAX_AMBIENT + MAX_WAKE;
export const WAVE_STRIDE = 8;

/** Peak dot displacement (along the ripple) as a fraction of grid spacing. */
export const WAVE_SHIFT = 0.2;
/** Share of each dot's own random X/Y wander, relative to the along-ripple motion. */
export const WAVE_WANDER = 0.6;
/** Opacity lift across the whole ring (relative), so a passing ripple reads as a brighter band… */
export const WAVE_LIFT = 0.25;
/** …plus a crest/trough swing on top of it. 40% dots range roughly 32% … 68%. */
export const WAVE_OPACITY = 0.45;

const FIRST_WAVE = [1.2, 3];
const MIN_GAP = 1.5;
const MEAN_EXTRA_GAP = 3;
const MAX_GAP = 10;
/** How far outside the edge the "fingertip" touches, CSS px. */
const SOURCE_OUTSET = 30;

/** A wake ring is dropped every this many CSS px of finger travel… */
const WAKE_SPACING = 24;
/** …but never more often than this (ms), however fast the finger moves. */
const WAKE_MIN_INTERVAL = 35;
/** Finger speed (CSS px/s) range mapped from the softest to the strongest wake. */
const WAKE_SPEED = [40, 900];
/** Wake rings fade with this time constant (s). */
const WAKE_DECAY = 0.7;
const SPEED_TAU = 0.08;

interface Wave {
  x: number;
  y: number;
  radius: number;
  speed: number;
  strength: number;
  wavelength: number;
  lead: number;
  tail: number;
  end: number;
  /** Seconds since birth, and the fade time constant (Infinity: fades only by spreading). */
  age: number;
  decay: number;
}

interface TrailPoint {
  x: number;
  y: number;
  time: number;
}

export class DotWaves {
  private readonly waves: Wave[] = [];
  private readonly wake: Wave[] = [];
  /** Retired waves, reused so a moving finger allocates nothing. */
  private readonly spare: Wave[] = [];
  private readonly trailFrom: TrailPoint = { x: 0, y: 0, time: 0 };
  private trailing = false;
  private trailTravel = 0;
  private lastWakeAt = -Infinity;
  private fingerSpeed = 0;
  private readonly random: () => number;
  private clock = 0;
  private nextAt: number;

  constructor(random: () => number = Math.random) {
    this.random = random;
    this.nextAt = FIRST_WAVE[0] + random() * (FIRST_WAVE[1] - FIRST_WAVE[0]);
  }

  get active(): boolean {
    return this.waves.length > 0 || this.wake.length > 0;
  }

  /** Edge and touch ripples currently travelling. */
  get count(): number {
    return this.waves.length;
  }

  /** Wake rings currently fading. */
  get wakeCount(): number {
    return this.wake.length;
  }

  /**
   * A ripple from the fingertip, at (x, y) in CSS px from the top-left. It
   * always gets a slot: if all are busy, the oldest ripple gives way.
   */
  touch(x: number, y: number, width: number, height: number, time = 0): void {
    this.setTrail(x, y, time);
    this.trailTravel = 0;
    this.fingerSpeed = 0;
    this.lastWakeAt = time;
    if (this.waves.length >= MAX_AMBIENT) this.spare.push(this.waves.shift()!);
    const r = this.random;
    const sx = x - width / 2;
    const sy = y - height / 2;
    const wavelength = 55 + r() * 30;
    const lead = wavelength * 0.55;
    const tail = wavelength * (1.4 + r() * 0.6);
    const farthest = Math.hypot(width / 2 + Math.abs(sx), height / 2 + Math.abs(sy));
    this.waves.push(
      this.make(sx, sy, 0, farthest + tail * 3, 170 + r() * 50, 0.9 + r() * 0.1, wavelength, lead, tail, Infinity),
    );
  }

  /**
   * The finger moved to (x, y) (CSS px from the top-left) at `time` (ms).
   * Drops wake rings along the path, stronger the faster it travels.
   */
  trail(x: number, y: number, width: number, height: number, time: number): void {
    const from = this.trailFrom;
    const wasTrailing = this.trailing;
    const distance = Math.hypot(x - from.x, y - from.y);
    const dt = (time - from.time) / 1000;
    this.setTrail(x, y, time);
    if (!wasTrailing) return;
    if (dt > 0.001) {
      this.fingerSpeed += (distance / dt - this.fingerSpeed) * (1 - Math.exp(-dt / SPEED_TAU));
    }
    this.trailTravel += distance;
    if (this.trailTravel < WAKE_SPACING || time - this.lastWakeAt < WAKE_MIN_INTERVAL) return;
    this.trailTravel = 0;
    this.lastWakeAt = time;

    const t = Math.min(Math.max((this.fingerSpeed - WAKE_SPEED[0]) / (WAKE_SPEED[1] - WAKE_SPEED[0]), 0), 1);
    const intensity = 0.2 + 0.8 * t * t * (3 - 2 * t);
    if (this.wake.length >= MAX_WAKE) this.spare.push(this.wake.shift()!);
    const wavelength = 34 + this.random() * 10;
    this.wake.push(
      this.make(x - width / 2, y - height / 2, 0, 500, 140 + 60 * t, intensity, wavelength, wavelength * 0.5, wavelength * 1.3, WAKE_DECAY),
    );
  }

  /** The finger left the surface: the wake already dropped keeps fading on its own. */
  lift(): void {
    this.trailing = false;
  }

  private setTrail(x: number, y: number, time: number): void {
    this.trailFrom.x = x;
    this.trailFrom.y = y;
    this.trailFrom.time = time;
    this.trailing = true;
  }

  private make(
    x: number,
    y: number,
    radius: number,
    end: number,
    speed: number,
    strength: number,
    wavelength: number,
    lead: number,
    tail: number,
    decay: number,
  ): Wave {
    const w = this.spare.pop() ?? ({} as Wave);
    w.x = x;
    w.y = y;
    w.radius = radius;
    w.end = end;
    w.speed = speed;
    w.strength = strength;
    w.wavelength = wavelength;
    w.lead = lead;
    w.tail = tail;
    w.age = 0;
    w.decay = decay;
    return w;
  }

  /** Advances the ripples. `width`/`height` are the viewport in CSS px. */
  step(dt: number, width: number, height: number): void {
    this.clock += dt;
    if (this.clock >= this.nextAt) {
      if (this.waves.length < MAX_AMBIENT) this.spawn(width, height);
      const r = this.random();
      this.nextAt = this.clock + Math.min(MIN_GAP - Math.log(1 - r) * MEAN_EXTRA_GAP, MAX_GAP);
    }
    advance(this.waves, dt, this.spare);
    advance(this.wake, dt, this.spare);
  }

  pack(out: Float32Array): void {
    out.fill(0);
    this.waves.forEach((w, i) => packWave(w, out, i * WAVE_STRIDE));
    this.wake.forEach((w, i) => packWave(w, out, (MAX_AMBIENT + i) * WAVE_STRIDE));
  }

  private spawn(width: number, height: number): void {
    const r = this.random;
    const hw = width / 2;
    const hh = height / 2;
    // A random point along a random edge, just beyond it.
    const along = 0.1 + r() * 0.8;
    let x: number;
    let y: number;
    switch (Math.floor(r() * 4)) {
      case 0: // top
        x = (along * 2 - 1) * hw;
        y = -hh - SOURCE_OUTSET;
        break;
      case 1: // bottom
        x = (along * 2 - 1) * hw;
        y = hh + SOURCE_OUTSET;
        break;
      case 2: // left
        x = -hw - SOURCE_OUTSET;
        y = (along * 2 - 1) * hh;
        break;
      default: // right
        x = hw + SOURCE_OUTSET;
        y = (along * 2 - 1) * hh;
    }
    const wavelength = 50 + r() * 60;
    const lead = wavelength * (0.5 + r() * 0.3);
    const tail = wavelength * (1.2 + r() * 1.2);
    // Retired once the whole packet is past the farthest corner.
    const farthest = Math.hypot(hw + Math.abs(x), hh + Math.abs(y));
    this.waves.push(
      this.make(x, y, -lead * 2, farthest + tail * 3, 120 + r() * 100, 0.6 + r() * 0.4, wavelength, lead, tail, Infinity),
    );
  }
}

function strengthOf(w: Wave): number {
  // Ripples soften as they spread (to ~60% at the far side) and wake rings also fade with age.
  const spread = Math.min(Math.max(w.radius / w.end, 0), 1);
  return w.strength * (1 - 0.4 * spread) * Math.exp(-w.age / w.decay);
}

function advance(list: Wave[], dt: number, spare: Wave[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const wave = list[i];
    wave.radius += wave.speed * dt;
    wave.age += dt;
    if (wave.radius > wave.end || strengthOf(wave) < 0.005) {
      // Remove in place (keeps age order, allocates nothing) and keep the object for reuse.
      for (let j = i; j < list.length - 1; j++) list[j] = list[j + 1];
      list.length--;
      spare.push(wave);
    }
  }
}

function packWave(w: Wave, out: Float32Array, o: number): void {
  out[o] = w.x;
  out[o + 1] = w.y;
  out[o + 2] = w.radius;
  out[o + 3] = strengthOf(w);
  out[o + 4] = w.wavelength;
  out[o + 5] = w.lead;
  out[o + 6] = w.tail;
}

const fract = (v: number) => v - Math.floor(v);
/** Per-dot random direction in [-1, 1]², from its grid cell. */
function wander(col: number, row: number, out: [number, number]): void {
  out[0] = fract(Math.sin(col * 12.9898 + row * 78.233) * 43758.5453) * 2 - 1;
  out[1] = fract(Math.sin(col * 39.3468 + row * 11.135) * 24634.6345) * 2 - 1;
}

const scratch: [number, number] = [0, 0];

/**
 * CPU version of the shader's `dotWaves` (used by the Canvas fallback): the same
 * model, though its per-dot randomness is not bit-identical to the GPU's.
 * (gx, gy) is the dot's rest position relative to the viewport centre.
 * Writes the displacement (CSS px) into `out` and returns the opacity factor.
 */
export function sampleDotWaves(
  waves: Float32Array,
  gx: number,
  gy: number,
  col: number,
  row: number,
  spacing: number,
  out: [number, number],
): number {
  out[0] = 0;
  out[1] = 0;
  let opacity = 1;
  let wandered = false;
  for (let i = 0; i < MAX_WAVES; i++) {
    const o = i * WAVE_STRIDE;
    const strength = waves[o + 3];
    if (strength <= 0) continue;
    if (!wandered) {
      wander(col, row, scratch);
      wandered = true;
    }
    const rx = gx - waves[o];
    const ry = gy - waves[o + 1];
    const dist = Math.hypot(rx, ry) || 1e-3;
    const d = dist - waves[o + 2];
    if (Math.abs(d) > 3 * Math.max(waves[o + 5], waves[o + 6])) continue;
    const width = d > 0 ? waves[o + 5] : waves[o + 6];
    const s = strength * Math.exp(-(d * d) / (width * width));
    if (s < 1e-4) continue;
    const phase = (2 * Math.PI * d) / waves[o + 4];
    const along = Math.sin(phase);
    const own = WAVE_WANDER * Math.cos(phase + scratch[0] * 2);
    const shift = s * WAVE_SHIFT * spacing;
    out[0] += ((rx / dist) * along + scratch[0] * own) * shift;
    out[1] += ((ry / dist) * along + scratch[1] * own) * shift;
    opacity += s * (WAVE_LIFT + WAVE_OPACITY * Math.cos(phase));
  }
  return Math.min(Math.max(opacity, 0.2), 2);
}
