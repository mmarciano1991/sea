import { pitchToHz, registerOf } from '../music/pitch';

/**
 * One sustained, continuously gliding voice.
 *
 * Source: two square oscillators (one a few cents sharp) plus a sine for body —
 * an odd-harmonic, woodwind-like core. Everything after them exists to take the
 * 8-bit edge off:
 *
 *   squares + sine → pre-filter → soft asymmetric saturation → pitch-tracked
 *   low-pass (with an attack "bloom") → body / presence EQ → amp → pan → out
 *
 * Pitch is a float that is never retriggered: oscillators start once and are
 * steered with short exponential glides, so movement in either axis is a
 * seamless, legato, click-free slide.
 */

const DETUNE_CENTS = 6;
const VIBRATO_CENTS = 7;
const DRIFT_CENTS = 1.6;

const ATTACK_TAU = 0.028;
const BLOOM_TAU = 0.11;
const RELEASE_TAU = 0.4;
const RELEASE_TAIL = 3.2;
const FAST_RELEASE_TAU = 0.03;

const curveCache = new WeakMap<BaseAudioContext, Float32Array<ArrayBuffer>>();

/** Gentle tanh saturation with a slight offset, adding a touch of even harmonics. */
function saturationCurve(ctx: BaseAudioContext): Float32Array<ArrayBuffer> {
  let curve = curveCache.get(ctx);
  if (!curve) {
    const n = 2048;
    const drive = 2;
    const bias = 0.08;
    const norm = Math.tanh(drive);
    curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (Math.tanh(drive * (x + bias)) - Math.tanh(drive * bias)) / norm;
    }
    curveCache.set(ctx, curve);
  }
  return curve;
}

/** Holds a param at its current value so new automation starts without a jump. */
function hold(param: AudioParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time);
  } else {
    const value = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }
}

export class Voice {
  private readonly ctx: AudioContext;
  private readonly oscillators: OscillatorNode[];
  private readonly modulators: OscillatorNode[];
  private readonly nodes: AudioNode[] = [];
  private readonly vibratoDepth: GainNode;
  private readonly preFilter: BiquadFilterNode;
  private readonly tone: BiquadFilterNode;
  private readonly amp: GainNode;
  private readonly panner: StereoPannerNode;

  private pitch: number;
  private brightness = 0;
  private vibrato = false;
  private released = false;
  private silenced = false;

  onEnded: (() => void) | null = null;

  /** @param pitch continuous float MIDI pitch */
  constructor(ctx: AudioContext, destination: AudioNode, pitch: number, pan: number) {
    this.ctx = ctx;
    this.pitch = pitch;
    const t = ctx.currentTime;
    const hz = pitchToHz(pitch);

    const osc = (type: OscillatorType, frequency: number, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = frequency;
      o.detune.value = detune;
      return o;
    };
    const gain = (value: number) => {
      const g = ctx.createGain();
      g.gain.value = value;
      this.nodes.push(g);
      return g;
    };

    const mix = gain(1);
    this.oscillators = [osc('square', hz), osc('square', hz, DETUNE_CENTS), osc('sine', hz)];
    const voicing = [0.5, 0.27, 0.42];

    // Vibrato (only when the hand is still) and a very slow organic drift.
    const lfo = osc('sine', 4.9 + Math.random() * 0.5);
    const drift = osc('sine', 0.17 + Math.random() * 0.1);
    this.vibratoDepth = gain(0);
    const driftDepth = gain(DRIFT_CENTS);
    lfo.connect(this.vibratoDepth);
    drift.connect(driftDepth);
    this.modulators = [lfo, drift];

    this.oscillators.forEach((o, i) => {
      o.connect(gain(voicing[i])).connect(mix);
      this.vibratoDepth.connect(o.detune);
      driftDepth.connect(o.detune);
    });

    this.preFilter = ctx.createBiquadFilter();
    this.preFilter.type = 'lowpass';
    this.preFilter.Q.value = 0.3;
    this.preFilter.frequency.value = this.preCutoff();

    const drive = gain(0.55);
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(ctx);
    shaper.oversample = '2x';

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.85;

    const bodyEq = ctx.createBiquadFilter();
    bodyEq.type = 'peaking';
    bodyEq.frequency.value = 260;
    bodyEq.Q.value = 0.9;
    bodyEq.gain.value = 2.5;

    const presenceEq = ctx.createBiquadFilter();
    presenceEq.type = 'peaking';
    presenceEq.frequency.value = 2900;
    presenceEq.Q.value = 0.9;
    presenceEq.gain.value = -4.5;

    this.amp = gain(0);
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = pan;

    mix.connect(this.preFilter).connect(drive).connect(shaper).connect(this.tone);
    this.tone.connect(bodyEq).connect(presenceEq).connect(this.amp).connect(this.panner).connect(destination);
    this.nodes.push(...this.oscillators, ...this.modulators, this.preFilter, shaper, this.tone, bodyEq, presenceEq, this.panner);

    // Attack: a soft swell in level, and the timbre "blooms" open just behind it.
    const cutoff = this.cutoff();
    this.tone.frequency.setValueAtTime(cutoff * 0.4, t);
    this.tone.frequency.setTargetAtTime(cutoff, t, BLOOM_TAU);
    this.amp.gain.setValueAtTime(0, t);
    this.amp.gain.setTargetAtTime(this.level(), t, ATTACK_TAU);

    for (const o of this.oscillators) o.start(t);
    for (const o of this.modulators) o.start(t);
    this.oscillators[0].onended = () => this.disconnect();
  }

  /** Continuous pitch change (float MIDI). `tau` is the glide time constant in seconds. */
  glide(pitch: number, pan: number, tau: number): void {
    if (this.released) return;
    this.pitch = pitch;
    const t = this.ctx.currentTime;
    const hz = pitchToHz(pitch);
    for (let i = 0; i < this.oscillators.length; i++) this.oscillators[i].frequency.setTargetAtTime(hz, t, tau);
    this.preFilter.frequency.setTargetAtTime(this.preCutoff(), t, tau);
    this.tone.frequency.setTargetAtTime(this.cutoff(), t, Math.max(tau, 0.03));
    this.amp.gain.setTargetAtTime(this.level(), t, 0.06);
    this.panner.pan.setTargetAtTime(pan, t, 0.06);
  }

  /** Movement speed opens the filter a little, like more bow. 0…1. */
  setBrightness(value: number): void {
    if (this.released || Math.abs(value - this.brightness) < 0.03) return;
    this.brightness = value;
    this.tone.frequency.setTargetAtTime(this.cutoff(), this.ctx.currentTime, 0.06);
  }

  /** Delayed vibrato: it blooms only on held, still notes and vanishes as soon as the hand moves. */
  setVibrato(on: boolean): void {
    if (this.released || on === this.vibrato) return;
    this.vibrato = on;
    this.vibratoDepth.gain.setTargetAtTime(on ? VIBRATO_CENTS : 0, this.ctx.currentTime, on ? 0.6 : 0.07);
  }

  /**
   * Musical release: level and brightness fall away together, then the graph
   * frees itself. `fast` silences within a few milliseconds and may also be
   * applied to a voice that is already in its normal release.
   */
  release(fast = false): void {
    if (this.silenced || (this.released && !fast)) return;
    this.released = true;
    this.silenced = fast;
    const t = this.ctx.currentTime;
    hold(this.amp.gain, t);
    hold(this.tone.frequency, t);
    this.amp.gain.setTargetAtTime(0, t, fast ? FAST_RELEASE_TAU : RELEASE_TAU);
    this.tone.frequency.setTargetAtTime(Math.max(180, this.cutoff() * 0.3), t, fast ? 0.05 : 0.7);
    const end = t + (fast ? 0.25 : RELEASE_TAIL);
    for (const o of this.oscillators) o.stop(end);
    for (const o of this.modulators) o.stop(end);
  }

  get isReleased(): boolean {
    return this.released;
  }

  private cutoff(): number {
    const harmonics = 2.4 + 3.2 * (1 - registerOf(this.pitch));
    return Math.min(Math.max(pitchToHz(this.pitch) * harmonics * (1 + 0.55 * this.brightness), 280), 7500);
  }

  private preCutoff(): number {
    return Math.min(pitchToHz(this.pitch) * 10, 12000);
  }

  /** Gentle equal-loudness compensation: higher notes are slightly quieter. */
  private level(): number {
    return 0.27 * Math.pow(10, (-6 * registerOf(this.pitch)) / 20);
  }

  private disconnect(): void {
    for (const node of this.nodes) node.disconnect();
    this.onEnded?.();
    this.onEnded = null;
  }
}
