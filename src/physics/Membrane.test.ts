import { describe, expect, it } from 'vitest';
import { CONTACT_STRIDE, MAX_CONTACTS, Membrane } from './Membrane';

const run = (m: Membrane, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) m.step(dt);
};

describe('membrane', () => {
  it('presses in, then returns fully to rest after release', () => {
    const m = new Membrane();
    const buf = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
    m.press(200, 300, 30, 1, 'touch');
    run(m, 0.3);
    expect(m.pack(buf)).toBe(1);
    expect(buf[2]).toBeGreaterThan(0.9);
    m.release();
    run(m, 6);
    expect(m.animating).toBe(false);
    expect(m.pack(buf)).toBe(0);
  });

  it('follows the finger with only a little lag, and stretches toward motion', () => {
    const m = new Membrane();
    const buf = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
    m.press(100, 100, 30, 1, 'mouse');
    for (let i = 1; i <= 30; i++) {
      m.move(100 + i * 8, 100); // 480 px/s
      m.step(1 / 60);
    }
    m.pack(buf);
    const lag = 100 + 30 * 8 - buf[0];
    expect(lag).toBeGreaterThan(2);
    expect(lag).toBeLessThan(30);
    expect(buf[8]).toBeGreaterThan(0.2); // lead points along +x
    expect(Math.abs(buf[4])).toBeGreaterThan(0.9); // ellipse turned toward motion
  });

  it('is frame-rate independent and stable with long frames', () => {
    const a = new Membrane();
    const b = new Membrane();
    const ba = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
    const bb = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
    a.press(0, 0, 30, 1, 'mouse');
    b.press(0, 0, 30, 1, 'mouse');
    run(a, 0.5, 1 / 144);
    run(b, 0.5, 1 / 30);
    a.pack(ba);
    b.pack(bb);
    expect(Math.abs(ba[2] - bb[2])).toBeLessThan(0.02);
  });

  it('never runs out of contacts under rapid tapping', () => {
    const m = new Membrane();
    const buf = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
    for (let i = 0; i < 40; i++) {
      m.press((i * 97) % 800, (i * 61) % 600, 30, 1, 'touch');
      run(m, 0.05);
      m.release();
    }
    expect(m.pack(buf)).toBeLessThanOrEqual(MAX_CONTACTS);
    run(m, 6);
    expect(m.animating).toBe(false);
  });
});
