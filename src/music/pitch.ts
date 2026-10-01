/**
 * The instrument's coordinate system.
 *
 *   horizontal → continuous pitch class (the note: C at the left edge … B … C′ at the right)
 *   vertical   → continuous octave      (bottom lowest, top highest)
 *
 * Both are analog controls. The sounding pitch is simply
 *
 *   pitch = C2 + pitchClass + 12 × octave
 *
 * so a small movement in either direction is a proportionally small change in
 * pitch — no zones, steps, thresholds or rounding anywhere, floating point
 * throughout. Vertically it behaves like a pitch fader spanning three octaves.
 *
 * Colour follows the same split (see visual/palette.ts): the horizontal note
 * sets the hue, the vertical register only lightens or deepens it.
 */

/** MIDI-style pitch of C at the lowest octave (C2 ≈ 65.4 Hz). */
export const BASE_PITCH = 36;

/** Semitones spanned by the full width. One octave: C … B … C′. */
export const HORIZONTAL_SPAN = 12;

/** Octaves spanned by the full height. */
export const REGISTER_OCTAVES = 3;

export interface Note {
  /** Continuous pitch class in semitones above C: 0 = C, 0.5 = C quarter-sharp, 11.73…, 12 = C′. */
  pitchClass: number;
  /** Continuous octave above the lowest: 0 … REGISTER_OCTAVES. */
  octave: number;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The note at a normalised surface position.
 * @param nx 0 at the left edge … 1 at the right edge
 * @param ny 0 at the bottom … 1 at the top
 */
export function noteAt(nx: number, ny: number, out: Note = { pitchClass: 0, octave: 0 }): Note {
  out.pitchClass = clamp01(nx) * HORIZONTAL_SPAN;
  out.octave = clamp01(ny) * REGISTER_OCTAVES;
  return out;
}

/** The sounding pitch (float MIDI) of a note: its pitch class, raised by its continuous octave. */
export function heightOf(note: Note): number {
  return BASE_PITCH + note.pitchClass + 12 * note.octave;
}

export function pitchToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** 0…1 position of a pitch inside the instrument's full range (used for timbre/level/lightness). */
export function registerOf(pitch: number): number {
  return clamp01((pitch - BASE_PITCH) / (HORIZONTAL_SPAN + 12 * REGISTER_OCTAVES));
}
