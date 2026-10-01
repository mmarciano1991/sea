import { heightOf, registerOf, type Note } from '../music/pitch';

/**
 * Colour of the membrane.
 *
 * The whole surface wears ONE colour at a time: the colour of the note that is
 * sounding. The chromatic scale is a mapping, never a gradient on screen.
 *
 *   note (pitch class) → hue        twelve OKLCH anchors joined by a Catmull-Rom
 *                                   spline: each note owns one hue, microtones give
 *                                   the colours in between
 *   octave             → lightness  low deep, high bright — never a different hue
 *   silence            → white
 */

/** OKLCH hue (degrees) for C, C#, D … B. Monotonic; C' wraps to C + 360°. */
export const HUE_ANCHORS = [
  29, // C   red
  44, // C#  red / orange
  60, // D   orange
  78, // D#  orange / yellow
  98, // E   yellow
  122, // F   yellow / green
  145, // F#  green
  170, // G   green / cyan
  200, // G#  cyan
  250, // A   blue
  295, // A#  violet
  335, // B   magenta
] as const;

/** Lightness (OKLab L) of the lowest and highest playable pitch. */
export const LIGHTNESS_LOW = 0.3;
export const LIGHTNESS_HIGH = 0.86;
/** The resting membrane: white, a breath short of paper-white so shading can read on it. */
export const WHITE_LIGHTNESS = 0.985;

export type RGB = [number, number, number];
/** A colour in OKLab: [L, a, b]. */
export type Lab = [number, number, number];

export const WHITE: Lab = [WHITE_LIGHTNESS, 0, 0];

function hueAnchor(k: number): number {
  const wrap = Math.floor(k / 12);
  return HUE_ANCHORS[k - wrap * 12] + 360 * wrap;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/** Hue in degrees for a continuous pitch class (0 = C, 11.5 = B quarter-sharp, 12 = C' ≡ C). */
export function hueAt(pitchClass: number): number {
  const i = Math.floor(pitchClass);
  const f = pitchClass - i;
  return catmullRom(hueAnchor(i - 1), hueAnchor(i), hueAnchor(i + 1), hueAnchor(i + 2), f);
}

/**
 * The colour of a note, in OKLab. Hue depends only on the pitch class; the
 * octave only lightens or deepens it. Lightness follows the perceived height
 * (octave plus the rise within it), so C′ at the right edge matches C one
 * octave up at the left — the same sound always wears the same colour.
 */
export function toneOf(note: Note, out: Lab = [0, 0, 0]): Lab {
  const height = registerOf(heightOf(note));
  const L = LIGHTNESS_LOW + (LIGHTNESS_HIGH - LIGHTNESS_LOW) * height;
  // Restrained chroma, easing off toward the bright end so high notes read as light, not neon.
  const C = 0.125 * (1 - 0.35 * height);
  const h = (hueAt(note.pitchClass) * Math.PI) / 180;
  out[0] = L;
  out[1] = C * Math.cos(h);
  out[2] = C * Math.sin(h);
  return out;
}

/** OKLab → linear sRGB (Björn Ottosson's matrices). Writes into `out`. */
export function oklabToLinear([L, a, b]: Lab, out: RGB = [0, 0, 0]): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

/**
 * Brings a linear colour into gamut by reducing chroma along the line to the
 * achromatic grey of the same OKLab lightness (L³ in linear light). Unlike
 * per-channel clamping this preserves hue — important for deep, dark tones.
 */
export function gamutMap(c: RGB, L: number): RGB {
  const grey = L * L * L;
  let t = 1;
  for (let i = 0; i < 3; i++) {
    const v = c[i];
    if (v < 0) t = Math.min(t, grey / (grey - v));
    else if (v > 1) t = Math.min(t, (1 - grey) / (v - grey));
  }
  for (let i = 0; i < 3; i++) c[i] = grey + (c[i] - grey) * t;
  return c;
}

/** OKLab → in-gamut linear sRGB. Writes into `out` (no allocation when one is given). */
export function labToLinear(lab: Lab, out: RGB = [0, 0, 0]): RGB {
  return gamutMap(oklabToLinear(lab, out), lab[0]);
}

export function linearToSrgb(c: number): number {
  const v = Math.min(Math.max(c, 0), 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
