import { CONTACT_STRIDE, MAX_CONTACTS } from '../physics/Membrane';

/**
 * Shape of an indentation in the membrane. These constants are injected into
 * the GLSL (shaders.ts) and mirrored by the TypeScript functions below, which
 * the Canvas fallback uses. Keep the two in sync.
 *
 * The profile is the sum of two parts:
 *   pad      1 / (1 + r⁴)         flat-bottomed where the fingertip pad presses
 *   tension  1 / (1 + 0.8 r²)     the long, gentle slope of a stretched sheet
 * minus a soft rim: material displaced by the press rises very slightly
 * around it, more on the leading side when moving (the "fold").
 */

/** Indentation depth at full pressure, as a fraction of the contact radius. */
export const HEIGHT_SCALE = 0.9;
/** How strongly material inside the dent is drawn toward its centre (perspective compression). */
export const COMPRESSION = 0.27;
/** How far the material is dragged along by a moving fingertip, in radii. */
export const DRAG = 0.2;
/** Directional asymmetry: steeper ahead of the motion, stretched behind. */
export const ASYMMETRY = 0.38;
/** Beyond this many radii a contact has no effect. */
export const REACH = 7;
/** Dots sink into the material but never vanish entirely, so the grid can be seen to bend. */
export const MAX_DOT_FADE = 0.85;
/** Dot diameter, CSS px. */
export const DOT_DIAMETER = 2;
/** Resting opacity of the dot mesh. */
export const DOT_OPACITY = 0.4;
/** Fraction of the width, at the left and right edges, over which the dots fade into the screen edge. */
export const DOT_EDGE_FADE = 0.2;

/** Note grid: one opacity for every line; sharps are told apart by being dashed. */
export const GRID_OPACITY = 0.5;
/** Dash and gap lengths of the sharps' lines, CSS px. */
export const GRID_DASH = 6;
export const GRID_GAP = 4;
/** Fraction of the height, at the top and bottom, over which the grid fades out. */
export const GRID_EDGE_FADE = 0.2;

/** Pitch classes of the sharps (C#, D#, F#, G#, A#). */
export const SHARPS: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);

function edgeRamp(v: number): number {
  const t = Math.min(Math.max(v / DOT_EDGE_FADE, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Dot opacity factor for a horizontal screen position 0…1: 1 in the middle, 0 at the side edges. */
export function dotEdgeFade(sx: number): number {
  return edgeRamp(sx) * edgeRamp(1 - sx);
}
/** Each dot shivers in place by up to this fraction of the grid spacing… */
export const DOT_JITTER = 0.11;
/** …at roughly this angular rate (rad/s)… */
export const DOT_JITTER_SPEED = 4.2;
/** …trailing a faint ghost of where it was this many seconds ago, at this relative strength. */
export const DOT_ECHO_LAG = 0.11;
export const DOT_ECHO = 0.42;

const fract = (x: number) => x - Math.floor(x);
function hash12(x: number, y: number): number {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fract((a + b) * c);
}

/** CPU mirror of the shader's per-dot shiver. Writes the offset (in spacings) into `out`. */
export function dotJitter(col: number, row: number, t: number, out: [number, number]): void {
  const p1 = hash12(col + 3.17, row + 3.17) * 6.2831853;
  const p2 = hash12(col * 1.31 + 7.73, row * 1.31 + 7.73) * 6.2831853;
  const r1 = 1 + hash12(col * 0.71 + 19.3, row * 0.71 + 19.3) * 0.8;
  const r2 = 1 + hash12(col * 1.93 + 41.1, row * 1.93 + 41.1) * 0.8;
  const w = DOT_JITTER_SPEED;
  out[0] = (Math.sin(t * r1 * w + p1) + 0.55 * Math.sin(t * r2 * w * 1.73 + p2)) / 1.55;
  out[1] = (Math.sin(t * r2 * w * 1.11 + p2 + 1.3) + 0.55 * Math.sin(t * r1 * w * 1.57 + p1)) / 1.55;
}

export const PAD_WEIGHT = 0.68;
export const RIM_AMOUNT = 0.07;
export const RIM_RADIUS = 2.3;
export const RIM_WIDTH = 1.6;
export const RIM_LEAD = 2.2;

export function profile(r: number): number {
  const r2 = r * r;
  const pad = 1 / (1 + r2 * r2);
  const tension = 1 / (1 + 0.8 * r2);
  const window = 1 - smooth(3.5, 6.5, r);
  return (PAD_WEIGHT * pad + (1 - PAD_WEIGHT) * tension) * window;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Anisotropic, slightly irregular normalised radius of offset (dx, dy) from a
 * packed contact at offset `o`. Matches `contactRadius` in the shader.
 */
export function contactRadius(c: Float32Array, o: number, dx: number, dy: number): number {
  const a = c[o + 3];
  const ax = c[o + 4];
  const ay = c[o + 5];
  const sa = Math.sqrt(c[o + 6]);
  let ex = (dx * ax + dy * ay) / sa / a;
  let ey = (ax * dy - ay * dx) * sa / a;
  const fwd = (dx * c[o + 8] + dy * c[o + 9]) / a;
  const k = Math.exp(ASYMMETRY * ((1.3 * fwd) / Math.sqrt(1 + 1.69 * fwd * fwd)));
  ex *= k;
  ey *= k;
  const rr = ex * ex + ey * ey + 1e-6;
  const ir = 1 / Math.sqrt(rr);
  const cx = ex * ir;
  const sx = ey * ir;
  const c2 = cx * cx - sx * sx;
  const s2 = 2 * cx * sx;
  const c3 = c2 * cx - s2 * sx;
  const s3 = s2 * cx + c2 * sx;
  const irregular = 1 + c2 * c[o + 12] + s2 * c[o + 13] + c3 * c[o + 14] + s3 * c[o + 15];
  return Math.sqrt(rr) / irregular;
}

/**
 * Forward displacement of material point (x, y) — where that point of the
 * membrane appears on screen, minus where it rests. Writes into `out`.
 * Returns the accumulated pressure at the point (0 = untouched, ~1 = under the pad).
 */
export function displace(c: Float32Array, count: number, x: number, y: number, out: [number, number]): number {
  out[0] = 0;
  out[1] = 0;
  let pressure = 0;
  if (count === 0) return 0;
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const o = i * CONTACT_STRIDE;
    const depth = c[o + 2];
    if (Math.abs(depth) < 1e-4) continue;
    const a = c[o + 3];
    const dx = x - c[o];
    const dy = y - c[o + 1];
    if (dx * dx + dy * dy > REACH * REACH * a * a) continue;
    const r = contactRadius(c, o, dx, dy);
    const p = profile(r);
    const pull = COMPRESSION * depth * p;
    const drag = a * DRAG * depth * Math.exp(-0.4 * r * r);
    // Fade to exactly zero before the cut-off (see reachWindow in the shader).
    const w = 1 - smooth(0.6 * REACH, REACH, Math.sqrt(dx * dx + dy * dy) / a);
    out[0] += (-dx * pull + c[o + 8] * drag) * w;
    out[1] += (-dy * pull + c[o + 9] * drag) * w;
    pressure += depth * p * w;
  }
  return pressure;
}

/** How much the dots have sunk into the material at a point (0 visible … 1 gone). */
export function dotFade(c: Float32Array, count: number, x: number, y: number): number {
  if (count === 0) return 0;
  let fade = 0;
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const o = i * CONTACT_STRIDE;
    const f = c[o + 7];
    if (f < 1e-3) continue;
    const r = contactRadius(c, o, x - c[o], y - c[o + 1]);
    fade += f * (1 - smooth(0.3, 1.6, r));
  }
  return Math.min(fade, 1) * MAX_DOT_FADE;
}

/**
 * A fine, dense, staggered mesh. Spacing scales gently with the viewport;
 * `coarsen` widens it for the CPU fallback, which draws every dot itself.
 */
export function dotGrid(cssWidth: number, cssHeight: number, coarsen = 1): { spacing: number; radius: number } {
  const spacing = Math.min(Math.max(Math.sqrt(cssWidth * cssHeight) / 96, 8.4), 13.2) * coarsen;
  return { spacing, radius: DOT_DIAMETER / 2 };
}
