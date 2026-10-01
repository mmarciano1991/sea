import { describe, expect, it } from 'vitest';
import { noteAt } from '../music/pitch';
import { HUE_ANCHORS, WHITE, hueAt, labToLinear, toneOf } from './palette';
import { HOLD_SECONDS, Tone } from './Tone';

const hueOf = (nx: number, ny: number) => {
  const [, a, b] = toneOf(noteAt(nx, ny));
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

describe('palette', () => {
  it('passes through every chromatic anchor', () => {
    HUE_ANCHORS.forEach((hue, i) => expect(hueAt(i)).toBeCloseTo(hue, 6));
  });

  it('gives every note its own hue — strictly rising from C to B, never revisited', () => {
    let previous = -Infinity;
    for (let i = 0; i < 11000; i++) {
      const h = hueAt((i / 11000) * 11.99);
      expect(h).toBeGreaterThan(previous);
      previous = h;
    }
    expect(hueAt(11.99)).toBeLessThan(hueAt(0) + 360);
  });

  it('is continuous — microtones give intermediate colours, no jumps', () => {
    let maxStep = 0;
    for (let i = 0; i < 12000; i++) {
      maxStep = Math.max(maxStep, Math.abs(hueAt(((i + 1) / 12000) * 12) - hueAt((i / 12000) * 12)));
    }
    expect(maxStep).toBeLessThan(0.1);
  });

  it('moving vertically never changes the hue, only the lightness', () => {
    for (const nx of [0, 0.21, 0.5, 0.77, 0.99]) {
      const base = hueOf(nx, 0);
      let lightness = -Infinity;
      for (let ny = 0; ny <= 1; ny += 0.02) {
        expect(hueOf(nx, ny)).toBeCloseTo(base, 6);
        const L = toneOf(noteAt(nx, ny))[0];
        expect(L).toBeGreaterThan(lightness);
        lightness = L;
      }
    }
  });

  it('stays inside the sRGB gamut', () => {
    for (let nx = 0; nx <= 1; nx += 0.01) {
      for (let ny = 0; ny <= 1; ny += 0.05) {
        for (const c of labToLinear(toneOf(noteAt(nx, ny)))) {
          expect(c).toBeGreaterThan(-1e-9);
          expect(c).toBeLessThan(1 + 1e-9);
        }
      }
    }
  });
});

describe('tone', () => {
  it('rests on white, diffuses toward the played note, and returns to white', () => {
    const tone = new Tone();
    const lowC = noteAt(0, 0);
    expect(tone.lightness).toBeCloseTo(WHITE[0], 6);
    expect(tone.paleness).toBe(1);
    tone.play(lowC, true);
    tone.step(1 / 60);
    expect(tone.lightness).toBeGreaterThan(0.85); // no instant switch
    for (let i = 0; i < 120; i++) tone.step(1 / 60);
    expect(tone.lightness).toBeCloseTo(toneOf(lowC)[0], 3);
    const [r, g, b] = tone.linear;
    expect(r).toBeGreaterThan(g); // low C: deep red
    expect(r).toBeGreaterThan(b);
    tone.rest();
    for (let i = 0; i < 900; i++) tone.step(1 / 60);
    expect(tone.settled).toBe(true);
    expect(tone.lightness).toBeCloseTo(WHITE[0], 4);
  });

  it('keeps the played colour for 5 s after release, then eases back to white', () => {
    const tone = new Tone();
    const note = noteAt(0.6, 0.4);
    tone.play(note, true);
    for (let i = 0; i < 120; i++) tone.step(1 / 60);
    const held = tone.lightness;
    tone.release();
    for (let t = 0; t < HOLD_SECONDS - 0.1; t += 1 / 60) tone.step(1 / 60);
    expect(tone.lightness).toBeCloseTo(held, 6); // still the note's colour
    for (let i = 0; i < 30; i++) tone.step(1 / 60);
    expect(tone.lightness).toBeGreaterThan(held); // whitening has begun…
    expect(tone.lightness).toBeLessThan(WHITE[0] - 0.05); // …smoothly, not at once
    for (let i = 0; i < 900; i++) tone.step(1 / 60);
    expect(tone.lightness).toBeCloseTo(WHITE[0], 4);
  });

  it('a new touch during the hold cancels the countdown', () => {
    const tone = new Tone();
    tone.play(noteAt(0.1, 0.2), true);
    for (let i = 0; i < 60; i++) tone.step(1 / 60);
    tone.release();
    for (let t = 0; t < 3; t += 1 / 60) tone.step(1 / 60);
    const next = noteAt(0.7, 0.5);
    tone.play(next, true);
    for (let t = 0; t < HOLD_SECONDS + 2; t += 1 / 60) tone.step(1 / 60); // still pressed
    expect(tone.lightness).toBeCloseTo(toneOf(next)[0], 3);
  });
});
