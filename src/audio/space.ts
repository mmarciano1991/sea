/**
 * The space the instrument sounds into: a long, dark, diffuse room with a
 * pair of soft ping-pong echoes that are mostly fed *into* the reverb, so they
 * read as distance rather than as discrete repeats.
 *
 *   input ─┬─ dry ───────────────────────────────┐
 *          ├─ preDelay → convolver → tone ─ wet ─┼─→ output
 *          └─ send → ping-pong ─┬─ (a little) ───┘
 *                               └─→ preDelay (most of it: echoes diffuse into the room)
 */

const DRY = 0.86;
const REVERB_SEND = 0.34;
const REVERB_RETURN = 0.62;
const ECHO_SEND = 0.15;
const ECHO_DIRECT = 0.22;
const ECHO_INTO_ROOM = 0.7;

export function createSpace(ctx: AudioContext, input: AudioNode, output: AudioNode): void {
  const gain = (value: number) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };
  const filter = (type: BiquadFilterType, frequency: number, q = 0.707) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  };

  // Dry path.
  input.connect(gain(DRY)).connect(output);

  // Room.
  const preDelay = ctx.createDelay(0.2);
  preDelay.delayTime.value = 0.03;
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulse(ctx);
  const roomLow = filter('highpass', 150);
  const roomHigh = filter('lowpass', 6200);
  input.connect(gain(REVERB_SEND)).connect(preDelay);
  preDelay.connect(convolver).connect(roomLow).connect(roomHigh).connect(gain(REVERB_RETURN)).connect(output);

  // Ping-pong echoes with darkening, thinning feedback.
  const send = gain(ECHO_SEND);
  const left = ctx.createDelay(2);
  const right = ctx.createDelay(2);
  left.delayTime.value = 0.43;
  right.delayTime.value = 0.61;
  const loop = (from: DelayNode, to: DelayNode) =>
    from.connect(filter('lowpass', 2100)).connect(filter('highpass', 260)).connect(gain(0.34)).connect(to);
  input.connect(send).connect(left);
  loop(left, right);
  loop(right, left);

  const merger = ctx.createChannelMerger(2);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  const echoes = filter('lowpass', 2600);
  merger.connect(echoes);
  echoes.connect(gain(ECHO_DIRECT)).connect(output);
  echoes.connect(gain(ECHO_INTO_ROOM)).connect(preDelay);
}

/**
 * Synthesises a stereo impulse response: decorrelated noise under an
 * exponential decay, progressively low-passed so the tail grows darker as it
 * fades — the way air and distance absorb high frequencies.
 */
export function createImpulse(ctx: BaseAudioContext, duration = 4.6, rt60 = 3.9): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const buffer = ctx.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let seed = 0x2f6b1a3d ^ (channel * 0x9e3779b9);
    let lowpassed = 0;
    for (let i = 0; i < length; i++) {
      // xorshift32: fast, deterministic, good enough for diffuse noise.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const white = (seed >>> 0) / 4294967296 - 0.5;

      const t = i / rate;
      const damping = 0.16 + 0.76 * (1 - Math.exp(-t / 1.1));
      lowpassed += (1 - damping) * (white - lowpassed);
      const compensation = Math.pow((1 + damping) / (1 - damping), 0.25);

      const onset = 1 - Math.exp(-t / 0.02);
      const decay = Math.exp((-6.9 * t) / rt60);
      const tail = Math.min(1, (duration - t) / 0.35);
      data[i] = lowpassed * compensation * onset * decay * tail;
    }
  }
  return buffer;
}
