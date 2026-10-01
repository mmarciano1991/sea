import type { Note } from '../music/pitch';
import { WHITE, labToLinear, smoothstep, toneOf, type Lab, type RGB } from './palette';

/** Seconds. The colour diffuses rather than switches. */
const ONSET_TAU = 0.22; // white → first colour on touch
const GLIDE_TAU = 0.12; // following a glide, a soft atmospheric lag
const REST_TAU = 1.3; // back to white
/** After the finger lifts, the membrane keeps the note's colour this long (s) before whitening. */
export const HOLD_SECONDS = 5;
const SETTLED = 1e-4;

/**
 * The membrane's single, evolving colour. It eases toward the colour of the
 * current note (or white in silence) in OKLab, so transitions between distant
 * hues pass through soft, desaturated light instead of sweeping a colour wheel,
 * and the B → C seam has no discontinuity.
 *
 * When the finger lifts, the colour of the note just played stays for
 * HOLD_SECONDS, then eases back to white; a new touch in the meantime simply
 * takes over and cancels the wait.
 */
export class Tone {
  // All state lives in fixed buffers: easing the colour allocates nothing per frame.
  private readonly lab: Lab = [...WHITE];
  private readonly target: Lab = [...WHITE];
  private readonly rgb: RGB = labToLinear(WHITE);
  private tau = REST_TAU;
  /** Seconds left before an untouched membrane whitens; 0 = not waiting. */
  private holdLeft = 0;

  play(note: Note, onset: boolean): void {
    this.holdLeft = 0;
    toneOf(note, this.target);
    this.tau = onset ? ONSET_TAU : GLIDE_TAU;
  }

  /** The finger lifted: keep the current colour, and whiten after HOLD_SECONDS. */
  release(): void {
    this.holdLeft = HOLD_SECONDS;
  }

  /** Whiten now (no hold). */
  rest(): void {
    this.holdLeft = 0;
    this.target[0] = WHITE[0];
    this.target[1] = WHITE[1];
    this.target[2] = WHITE[2];
    this.tau = REST_TAU;
  }

  step(dt: number): void {
    if (this.holdLeft > 0) {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0) this.rest();
    }
    if (this.settled) return;
    const k = 1 - Math.exp(-dt / this.tau);
    for (let i = 0; i < 3; i++) this.lab[i] += (this.target[i] - this.lab[i]) * k;
    if (this.settled) {
      // Land exactly, e.g. on true white.
      this.lab[0] = this.target[0];
      this.lab[1] = this.target[1];
      this.lab[2] = this.target[2];
    }
    labToLinear(this.lab, this.rgb);
  }

  get settled(): boolean {
    const [L, a, b] = this.lab;
    const [tL, ta, tb] = this.target;
    return Math.abs(L - tL) + Math.abs(a - ta) + Math.abs(b - tb) < SETTLED;
  }

  /** Current colour, linear sRGB. */
  get linear(): RGB {
    return this.rgb;
  }

  get lightness(): number {
    return this.lab[0];
  }

  /**
   * 0 on coloured fields, 1 on the near-white membrane: where white marks
   * (dots, UI) would disappear and should switch to a soft grey ink.
   */
  get paleness(): number {
    return smoothstep(0.78, 0.93, this.lab[0]);
  }
}
