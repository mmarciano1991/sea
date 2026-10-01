import { describe, expect, it } from 'vitest';
import { DotWaves, MAX_AMBIENT, MAX_WAKE, MAX_WAVES, WAVE_STRIDE, sampleDotWaves } from './DotWaves';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1200;
const H = 800;
const buffer = () => new Float32Array(MAX_WAVES * WAVE_STRIDE);

describe('dot waves', () => {
  it('always start just outside one of the four edges, from every side over time', () => {
    const waves = new DotWaves(seeded(11));
    const buf = buffer();
    const sides = new Set<string>();
    let previous = 0;
    for (let t = 0; t < 200; t += 1 / 60) {
      waves.step(1 / 60, W, H);
      if (waves.count > previous) {
        waves.pack(buf);
        const o = (waves.count - 1) * WAVE_STRIDE;
        const x = buf[o];
        const y = buf[o + 1];
        const outside = Math.abs(x) > W / 2 || Math.abs(y) > H / 2;
        expect(outside).toBe(true);
        sides.add(Math.abs(x) > W / 2 ? (x < 0 ? 'left' : 'right') : y < 0 ? 'top' : 'bottom');
      }
      expect(waves.count).toBeLessThanOrEqual(MAX_AMBIENT);
      previous = waves.count;
    }
    expect(sides).toEqual(new Set(['top', 'bottom', 'left', 'right']));
  });

  it('arrive at irregular intervals', () => {
    const waves = new DotWaves(seeded(7));
    const arrivals: number[] = [];
    let previous = 0;
    for (let t = 0; t < 120; t += 1 / 60) {
      waves.step(1 / 60, W, H);
      if (waves.count > previous) arrivals.push(t);
      previous = waves.count;
    }
    expect(arrivals.length).toBeGreaterThan(8);
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(1);
  });

  it('are clearly visible but restrained, and every dot recovers completely', () => {
    const waves = new DotWaves(seeded(3));
    const buf = buffer();
    const out: [number, number] = [0, 0];
    const spacing = 10;
    let maxShift = 0;
    let minOpacity = 1;
    let maxOpacity = 1;
    for (let t = 0; t < 20; t += 1 / 30) {
      waves.step(1 / 30, W, H);
      waves.pack(buf);
      for (let x = -560; x <= 560; x += 40) {
        for (let y = -360; y <= 360; y += 60) {
          const o = sampleDotWaves(buf, x, y, x / 10, y / 10, spacing, out);
          maxShift = Math.max(maxShift, Math.hypot(out[0], out[1]));
          minOpacity = Math.min(minOpacity, o);
          maxOpacity = Math.max(maxOpacity, o);
        }
      }
    }
    expect(maxShift).toBeGreaterThan(spacing * 0.15); // noticeable
    expect(maxShift).toBeLessThan(spacing * 0.5); // never leaves its neighbourhood
    expect(maxOpacity).toBeGreaterThan(1.4); // a passing ring reads as a brighter band
    expect(minOpacity).toBeGreaterThan(0.5);
  });

  it('leaves every dot exactly at rest once a wave has passed — nothing accumulates', () => {
    // A random source near 1 spawns one wave, then waits the maximum gap before the next.
    const waves = new DotWaves(() => 0.999999);
    const buf = buffer();
    const out: [number, number] = [0, 0];
    let sawWave = false;
    let rested = false;
    for (let t = 0; t < 120 && !rested; t += 1 / 60) {
      waves.step(1 / 60, 600, 400); // small enough for a ripple to clear before the next
      sawWave ||= waves.active;
      rested = sawWave && !waves.active;
    }
    expect(rested).toBe(true);
    waves.pack(buf);
    for (let x = -300; x <= 300; x += 20) {
      for (let y = -200; y <= 200; y += 20) {
        expect(sampleDotWaves(buf, x, y, x, y, 10, out)).toBe(1);
        expect(out).toEqual([0, 0]);
      }
    }
  });

  it('sends a ripple out from a touch, always making room for it', () => {
    const waves = new DotWaves(seeded(9));
    const buf = buffer();
    for (let i = 0; i < MAX_AMBIENT; i++) waves.touch(100 * i, 50, W, H);
    waves.touch(300, 200, W, H);
    expect(waves.count).toBe(MAX_AMBIENT);
    waves.pack(buf);
    const o = (MAX_AMBIENT - 1) * WAVE_STRIDE;
    expect([buf[o], buf[o + 1], buf[o + 2]]).toEqual([300 - W / 2, 200 - H / 2, 0]);
    expect(buf[o + 3]).toBeGreaterThan(0.85);
  });

  it('leaves a wake that follows the finger: stronger when fast, fading back to rest', () => {
    const wakeOf = (pxPerFrame: number) => {
      const waves = new DotWaves(seeded(4));
      const buf = buffer();
      waves.touch(100, 400, W, H, 0);
      let strongest = 0;
      const rings: number[][] = [];
      for (let i = 1; i <= 60; i++) {
        waves.trail(100 + i * pxPerFrame, 400, W, H, i * 16.7);
        waves.step(1 / 60, W, H);
        waves.pack(buf);
        for (let k = MAX_AMBIENT; k < MAX_WAVES; k++) {
          const o = k * WAVE_STRIDE;
          strongest = Math.max(strongest, buf[o + 3]);
          if (buf[o + 3] > 0) rings.push([buf[o], buf[o + 1]]);
        }
        expect(waves.wakeCount).toBeLessThanOrEqual(MAX_WAKE);
      }
      return { waves, strongest, rings };
    };

    const slow = wakeOf(1.5); // ~90 px/s
    const fast = wakeOf(12); // ~720 px/s
    expect(fast.strongest).toBeGreaterThan(slow.strongest * 1.8);
    // Rings sit on the finger's path (y = 400 → 0 relative to centre), behind the fingertip.
    for (const [x, y] of fast.rings) {
      expect(y).toBeCloseTo(0, 6);
      expect(x).toBeLessThanOrEqual(100 + 60 * 12 - W / 2 + 1e-6);
    }

    // Finger lifted: the wake dies away completely; nothing accumulates.
    fast.waves.lift();
    for (let i = 0; i < 600 && fast.waves.wakeCount > 0; i++) fast.waves.step(1 / 60, W, H);
    expect(fast.waves.wakeCount).toBe(0);
  });

  it('does not make a wake while the finger is still', () => {
    const waves = new DotWaves(seeded(2));
    waves.touch(300, 300, W, H, 0);
    for (let i = 1; i < 120; i++) waves.trail(300, 300, W, H, i * 16.7);
    expect(waves.wakeCount).toBe(0);
  });
});
