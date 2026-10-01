import { describe, expect, it } from 'vitest';
import { droneRootFor } from './Drone';

describe('drone key', () => {
  it('places every key, microtones included, in one fixed octave (E2 … D#3)', () => {
    for (let pc = 0; pc <= 12; pc += 0.01) {
      const root = droneRootFor(pc);
      expect(root).toBeGreaterThanOrEqual(40);
      expect(root).toBeLessThan(52);
      // Same pitch class as the played note.
      const m = (((root - 36 - pc) % 12) + 12) % 12;
      expect(Math.min(m, 12 - m)).toBeCloseTo(0, 6);
    }
  });

  it('never moves the octave across B → C', () => {
    expect(droneRootFor(11.9)).toBeCloseTo(47.9, 9);
    expect(droneRootFor(0.1)).toBeCloseTo(48.1, 9);
    expect(droneRootFor(12)).toBe(droneRootFor(0));
  });
});
