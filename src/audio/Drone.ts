import { pitchToHz } from '../music/pitch';

/**
 * Music Mode: a soft, ambient harmonic bed in the key of the last played note.
 *
 * Several quiet layers, each a different kind of synth:
 *   pad      detuned saw pairs on root, fifth and octave, heavily low-passed
 *            with a very slow sweep: warm and blurred, never buzzy
 *   body     a pure sine on the root, for weight without edges
 *   glass    soft triangles a twelfth and two octaves up, darkened
 *   shimmer  high sines that bloom and fade at random moments, each with a
 *            faint tremble — a slow, irregular sparkle over the bed
 *   air      band-passed noise breathing very slowly underneath
 *
 * The octave never changes: the root always lives in one fixed octave
 * (ROOT_FLOOR … +12), whatever the key. Small key changes (microtonal moves,
 * a semitone) glide; larger ones cross-fade between chords, so the harmony
 * shifts like light changing rather than sliding audibly through pitches.
 * Everything feeds the same room as the voice, and sits well beneath it.
 */

/** Lowest root: E2. Every key's root is placed in E2 … D#3, so the octave stays put. */
const ROOT_FLOOR = 40;
const OUTPUT_LEVEL = 0.05;
/** Key changes up to this many semitones glide; larger ones cross-fade. */
const GLIDE_LIMIT = 1.5;
const KEY_GLIDE_TAU = 0.8;
const FADE_IN_TAU = 1.6;
const FADE_OUT_TAU = 1.1;
/** On a key change the new chord blooms quicker than the old one dissolves, so the bed never thins. */
const KEY_FADE_IN_TAU = 0.7;
const KEY_FADE_OUT_TAU = 1.8;

/** [interval in semitones, level] */
const PAD: ReadonlyArray<[number, number]> = [
  [0, 0.5],
  [7, 0.34],
  [12, 0.3],
];
const GLASS: ReadonlyArray<[number, number]> = [
  [19, 0.06],
  [24, 0.045],
];
const SHIMMER: ReadonlyArray<number> = [24, 31, 36, 43];

/** Places a pitch class (0…12, float) in the drone's fixed octave. */
export function droneRootFor(pitchClass: number): number {
  const offset = (((pitchClass - (ROOT_FLOOR - 36)) % 12) + 12) % 12;
  return ROOT_FLOOR + offset;
}

/** One chord of the bed: every pitched layer, tuned to one root. */
class Chord {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly tuned: Array<[OscillatorNode, number]> = [];
  private readonly sources: OscillatorNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly shimmer: GainNode[] = [];
  private readonly padSend: GainNode;
  private sparkleTimer = 0;
  private stopped = false;
  root: number;

  constructor(ctx: AudioContext, destination: AudioNode, padFilter: AudioNode, root: number, fadeIn = FADE_IN_TAU) {
    this.ctx = ctx;
    this.root = root;
    const t = ctx.currentTime;
    this.output = this.gain(0);
    this.output.connect(destination);

    const voice = (type: OscillatorType, interval: number, detune: number, level: number, into: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = pitchToHz(root + interval);
      o.detune.value = detune;
      const g = this.gain(level);
      o.connect(g).connect(into);
      this.tuned.push([o, interval]);
      this.sources.push(o);
      this.nodes.push(o);
      return g;
    };

    // Pad: this chord's saws go through its own send into the shared, slowly
    // sweeping pad filter. The send fades with the chord, so the pad does too.
    this.padSend = this.gain(0);
    this.padSend.connect(padFilter);
    for (const [interval, level] of PAD) {
      voice('sawtooth', interval, -7, level / 2, this.padSend);
      voice('sawtooth', interval, 7, level / 2, this.padSend);
    }

    voice('sine', 0, 0, 0.32, this.output);

    const glassTone = ctx.createBiquadFilter();
    glassTone.type = 'lowpass';
    glassTone.frequency.value = 2400;
    glassTone.connect(this.output);
    this.nodes.push(glassTone);
    for (const [interval, level] of GLASS) voice('triangle', interval, 3, level, glassTone);

    // Shimmer partials: silent until a sparkle blooms them, each with a faint tremble.
    const tremble = ctx.createOscillator();
    tremble.frequency.value = 5.3;
    const trembleDepth = this.gain(6);
    tremble.connect(trembleDepth);
    this.sources.push(tremble);
    this.nodes.push(tremble);
    for (const interval of SHIMMER) {
      const g = voice('sine', interval, 0, 0, this.output);
      trembleDepth.connect(this.tuned[this.tuned.length - 1][0].detune);
      this.shimmer.push(g);
    }

    for (const o of this.sources) o.start(t);
    this.sources[0].onended = () => {
      for (const node of this.nodes) node.disconnect();
    };
    this.output.gain.setTargetAtTime(1, t, fadeIn);
    this.padSend.gain.setTargetAtTime(1, t, fadeIn);
    this.scheduleSparkle(1.5);
  }

  glideTo(root: number): void {
    this.root = root;
    const t = this.ctx.currentTime;
    for (const [o, interval] of this.tuned) o.frequency.setTargetAtTime(pitchToHz(root + interval), t, KEY_GLIDE_TAU);
  }

  stop(fast = false, tau = fast ? 0.05 : FADE_OUT_TAU): void {
    if (this.stopped) return;
    this.stopped = true;
    window.clearTimeout(this.sparkleTimer);
    const t = this.ctx.currentTime;
    for (const g of [this.output.gain, this.padSend.gain]) {
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
      else {
        const v = g.value;
        g.cancelScheduledValues(t);
        g.setValueAtTime(v, t);
      }
      g.setTargetAtTime(0, t, tau);
    }
    for (const o of this.sources) o.stop(t + tau * 7);
  }

  /** At irregular moments, one high partial blooms softly and fades away again. */
  private scheduleSparkle(delay: number): void {
    this.sparkleTimer = window.setTimeout(() => {
      if (this.stopped) return;
      const g = this.shimmer[Math.floor(Math.random() * this.shimmer.length)];
      const t = this.ctx.currentTime;
      const peak = 0.012 + Math.random() * 0.022;
      g.gain.setTargetAtTime(peak, t, 0.12 + Math.random() * 0.25);
      g.gain.setTargetAtTime(0, t + 0.4 + Math.random() * 0.6, 0.5 + Math.random() * 0.9);
      this.scheduleSparkle(0.35 + Math.random() * 1.4);
    }, delay * 1000);
  }

  private gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }
}

export class Drone {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly sources: OscillatorNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private chord: Chord;
  private readonly fading = new Set<Chord>();
  private stopped = false;

  /** @param pitchClass key of the drone (0…12, float) */
  constructor(ctx: AudioContext, destination: AudioNode, pitchClass: number) {
    this.ctx = ctx;
    const t = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(destination);

    // Shared pad filter with a very slow sweep (~25 s).
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 520;
    this.padFilter.Q.value = 0.35;
    this.padFilter.connect(this.output);
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.04;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 170;
    sweep.connect(sweepDepth).connect(this.padFilter.frequency);

    // Air: noise, band-passed high and breathing on a slow, separate cycle.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = 2600;
    air.Q.value = 0.6;
    const airLevel = ctx.createGain();
    airLevel.gain.value = 0.05;
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.09;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.035;
    breath.connect(breathDepth).connect(airLevel.gain);
    noise.connect(air).connect(airLevel).connect(this.output);

    this.nodes.push(this.output, this.padFilter, sweep, sweepDepth, noise, air, airLevel, breath, breathDepth);
    this.sources.push(sweep, breath);
    for (const o of this.sources) o.start(t);
    noise.start(t);
    this.stopNoise = (at: number) => noise.stop(at);
    this.sources[0].onended = () => {
      for (const node of this.nodes) node.disconnect();
    };

    this.chord = new Chord(ctx, this.output, this.padFilter, droneRootFor(pitchClass));
    this.output.gain.setTargetAtTime(OUTPUT_LEVEL, t, FADE_IN_TAU);
  }

  private readonly stopNoise: (at: number) => void;

  /** Move the bed to a new key (pitch class 0…12, float), always in the same octave. */
  setKey(pitchClass: number): void {
    if (this.stopped) return;
    const root = droneRootFor(pitchClass);
    if (Math.abs(root - this.chord.root) <= GLIDE_LIMIT) {
      this.chord.glideTo(root);
      return;
    }
    // A real change of key: let the old chord dissolve while the new one blooms.
    const old = this.chord;
    old.stop(false, KEY_FADE_OUT_TAU);
    this.fading.add(old);
    window.setTimeout(() => this.fading.delete(old), KEY_FADE_OUT_TAU * 7000);
    this.chord = new Chord(this.ctx, this.output, this.padFilter, root, KEY_FADE_IN_TAU);
  }

  /** Fade out and free everything. */
  stop(fast = false): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    const tau = fast ? 0.05 : FADE_OUT_TAU;
    this.chord.stop(fast);
    for (const c of this.fading) c.stop(true);
    const g = this.output.gain;
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
    else {
      const v = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(v, t);
    }
    g.setTargetAtTime(0, t, tau);
    for (const o of this.sources) o.stop(t + tau * 7);
    this.stopNoise(t + tau * 7);
  }
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Two seconds of white noise, generated once per context and looped. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseCache.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x1d872b41;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = (seed >>> 0) / 2147483648 - 1;
    }
    noiseCache.set(ctx, buffer);
  }
  return buffer;
}
