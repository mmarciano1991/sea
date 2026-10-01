import { Drone } from './Drone';
import { createSpace } from './space';
import { Voice } from './Voice';

/** Glide time constants (seconds). Short enough to feel immediate, long enough to never click. */
export const GLIDE_TOUCH = 0.009;
export const GLIDE_LAYOUT = 0.14;

const MAX_RELEASING = 6;
const STILL_SPEED = 0.04;
const VIBRATO_DELAY = 0.45;

type AudioContextCtor = typeof AudioContext;

/**
 * Owns the AudioContext, the master chain and the (monophonic) playing voice.
 * Earlier voices keep sounding through their release tails while a new one
 * starts, so quick repeated touches overlap naturally. In Music Mode it also
 * keeps a drone in the key of the last played note.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private volumeNode: GainNode | null = null;
  private voice: Voice | null = null;
  private readonly releasing = new Set<Voice>();

  private volume = 0.7;
  private brightness = 0;
  private stillFor = 0;
  private suspendTimer = 0;

  private musicMode = false;
  private drone: Drone | null = null;
  /** Pitch class (0…12, float) of the last played note: the drone's key. */
  private key = 0;

  /**
   * Creates or resumes the context. Must be called from inside a user gesture
   * (autoplay policy); safe to call repeatedly.
   */
  unlock(): void {
    window.clearTimeout(this.suspendTimer);
    if (!this.ctx) this.build();
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => undefined);
    if (this.musicMode && !this.drone) this.startDrone();
  }

  /** Music Mode on/off. Call from a user gesture so the context may start. */
  setMusicMode(on: boolean): void {
    this.musicMode = on;
    if (on) {
      if (this.ctx) this.startDrone();
    } else {
      this.drone?.stop();
      this.drone = null;
    }
  }

  /** The key for the drone: the pitch class (0…12, float) of the note being played. */
  setKey(pitchClass: number): void {
    this.key = pitchClass;
    this.drone?.setKey(pitchClass);
  }

  /** @param pitch continuous float MIDI pitch */
  noteOn(pitch: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    this.noteOff();
    this.brightness = 0;
    this.stillFor = 0;
    this.voice = new Voice(ctx, this.bus, pitch, pan);
  }

  glide(pitch: number, pan: number, tau: number): void {
    this.voice?.glide(pitch, pan, tau);
  }

  noteOff(fast = false): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    voice.release(fast);
    this.releasing.add(voice);
    voice.onEnded = () => this.releasing.delete(voice);
    if (this.releasing.size > MAX_RELEASING) {
      const oldest = this.releasing.values().next().value;
      oldest?.release(true);
    }
  }

  /**
   * Per-frame expression from hand movement.
   * @param speed hand speed in viewport-lengths per second
   */
  express(dt: number, speed: number): void {
    const voice = this.voice;
    if (!voice) return;
    const target = Math.min(speed / 1.2, 1);
    const tau = target > this.brightness ? 0.05 : 0.35;
    this.brightness += (target - this.brightness) * (1 - Math.exp(-dt / tau));
    voice.setBrightness(this.brightness);

    this.stillFor = speed < STILL_SPEED ? this.stillFor + dt : 0;
    voice.setVibrato(this.stillFor > VIBRATO_DELAY);
  }

  setVolume(value: number): void {
    this.volume = value;
    const node = this.volumeNode;
    if (node && this.ctx) node.gain.setTargetAtTime(this.volumeGain(), this.ctx.currentTime, 0.05);
  }

  /** Page hidden: silence everything quickly, then let the device sleep. */
  sleep(): void {
    this.noteOff(true);
    this.drone?.stop(true);
    this.drone = null;
    for (const voice of this.releasing) voice.release(true);
    window.clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => {
      if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => undefined);
    }, 400);
  }

  dispose(): void {
    window.clearTimeout(this.suspendTimer);
    this.voice = null;
    this.drone = null;
    this.releasing.clear();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.bus = null;
    this.volumeNode = null;
  }

  private build(): void {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;

    // iOS: play through the ringer switch, like a real instrument app would.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        /* unsupported value — ignore */
      }
    }

    const ctx = new Ctor({ latencyHint: 'interactive' });
    const bus = ctx.createGain();
    const mix = ctx.createGain();
    createSpace(ctx, bus, mix);

    // Transparent safety limiter: only overlapping release tails should ever touch it.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;

    const volume = ctx.createGain();
    volume.gain.value = this.volumeGain();
    mix.connect(limiter).connect(volume).connect(ctx.destination);

    this.ctx = ctx;
    this.bus = bus;
    this.volumeNode = volume;
  }

  private startDrone(): void {
    if (!this.ctx || !this.bus || this.drone) return;
    this.drone = new Drone(this.ctx, this.bus, this.key);
  }

  /** Perceptual volume curve. */
  private volumeGain(): number {
    return this.volume * this.volume;
  }
}
