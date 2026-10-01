import { describe, expect, it } from 'vitest';
import { BASE_PITCH, REGISTER_OCTAVES, heightOf, noteAt, pitchToHz } from './pitch';

describe('note mapping', () => {
  it('horizontal is continuous pitch class — never rounded, no plateaus', () => {
    expect(noteAt(0.0123, 0).pitchClass).toBeCloseTo(0.1476, 6);
    let previous = -Infinity;
    for (let i = 0; i <= 10000; i++) {
      const pc = noteAt(i / 10000, 0.3).pitchClass;
      expect(pc).toBeGreaterThan(previous);
      previous = pc;
    }
    // One pixel on a 390 px phone is a perceptible ~3 cent step.
    const step = noteAt(101 / 390, 0.5).pitchClass - noteAt(100 / 390, 0.5).pitchClass;
    expect(step).toBeGreaterThan(0.02);
    expect(step).toBeLessThan(0.05);
  });

  it('vertical is a linear octave fader — equal movement, equal pitch change, everywhere', () => {
    const n = 3000;
    const expected = (12 * REGISTER_OCTAVES) / n;
    for (let i = 0; i < n; i++) {
      const step = heightOf(noteAt(0.4, (i + 1) / n)) - heightOf(noteAt(0.4, i / n));
      // Identical step size across the whole height: no zones, thresholds or plateaus,
      // including where one octave becomes the next.
      expect(step).toBeCloseTo(expected, 9);
    }
  });

  it('never changes the note when moving vertically', () => {
    for (let y = 0; y <= 1; y += 0.01) {
      expect(noteAt(0.37, y).pitchClass).toBe(noteAt(0.37, 0).pitchClass);
    }
  });

  it('spans C2 at the bottom-left to three octaves up, with C′ an octave above C', () => {
    expect(heightOf(noteAt(0, 0))).toBe(BASE_PITCH);
    expect(heightOf(noteAt(0, 1))).toBe(BASE_PITCH + 36);
    expect(heightOf(noteAt(1, 0.4)) - heightOf(noteAt(0, 0.4))).toBeCloseTo(12, 9);
  });

  it('writes into a reused note without allocating', () => {
    const out = { pitchClass: 0, octave: 0 };
    expect(noteAt(0.5, 0.5, out)).toBe(out);
    expect(out).toEqual({ pitchClass: 6, octave: 1.5 });
  });

  it('converts to frequency with A4 = 440 Hz', () => {
    expect(pitchToHz(69)).toBe(440);
    expect(pitchToHz(69.5)).toBeCloseTo(440 * Math.pow(2, 0.5 / 12), 9);
  });
});
