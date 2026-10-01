import { AudioEngine, GLIDE_LAYOUT, GLIDE_TOUCH } from '../audio/AudioEngine';
import { disposeHaptics, hapticTap } from '../interaction/haptics';
import { InteractionEngine, type PointerSample } from '../interaction/InteractionEngine';
import { heightOf, noteAt, type Note } from '../music/pitch';
import { CONTACT_STRIDE, MAX_CONTACTS, Membrane } from '../physics/Membrane';
import { DotWaves, MAX_WAVES, WAVE_STRIDE } from '../visual/DotWaves';
import { QualityGovernor } from '../visual/quality';
import { createSurface, type SurfaceFrame, type SurfaceRenderer } from '../visual/surface';
import { Tone } from '../visual/Tone';

const IDLE_FRAME_MS = 1000 / 30;
/** The note grid fades in and out with this time constant (s). */
const GRID_TAU = 0.12;
const SPEED_TAU = 0.06;
const SPEED_DECAY_TAU = 0.12;
/** Stereo width of the pitch axis: left of the surface sits slightly left in the room. */
const PAN_WIDTH = 0.5;

/**
 * Wires the engines into one physical system:
 *
 *   pointer ─┬─→ audio   (immediately, in the event handler: note, octave, pan)
 *            ├─→ tone    (the membrane's one colour: note → hue, octave → lightness)
 *            └─→ membrane target
 *   frame   ───→ membrane physics + tone easing → renderer;  hand speed → audio expression
 *
 * Nothing here touches React. High-frequency work happens in native event
 * handlers and a single requestAnimationFrame loop, and none of it allocates:
 * the note, the frame description and every buffer are reused, so the garbage
 * collector never interrupts a gesture.
 */
export class Instrument {
  private readonly host: HTMLElement;
  private readonly audio = new AudioEngine();
  private readonly membrane = new Membrane();
  private readonly tone = new Tone();
  private readonly dotWaves = new DotWaves();
  private readonly waves = new Float32Array(MAX_WAVES * WAVE_STRIDE);
  private readonly governor = new QualityGovernor();
  private readonly interaction: InteractionEngine;
  private readonly renderer: SurfaceRenderer;
  private readonly contacts = new Float32Array(CONTACT_STRIDE * MAX_CONTACTS);
  private readonly note: Note = { pitchClass: 0, octave: 0 };
  private readonly frameState: SurfaceFrame;
  private readonly resizeObserver: ResizeObserver;

  private width = 1;
  private height = 1;
  private raf = 0;
  private lastFrame = 0;
  private lastRender = 0;
  private readonly epoch = performance.now();
  private revealed = false;

  // Hand motion, for expression (plain numbers: pointer samples are reused objects).
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private speed = 0;
  private lastMoveAt = 0;

  private dprQuery: MediaQueryList | null = null;
  private uiPaleness = -1;
  private grid = 0;
  private gridTarget = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = createSurface(host);
    this.frameState = {
      time: 0,
      contacts: this.contacts,
      liveContacts: 0,
      tone: this.tone.linear,
      paleness: 1,
      waves: this.waves,
      grid: 0,
    };
    this.interaction = new InteractionEngine(host, {
      press: this.onPress,
      move: this.onMove,
      release: this.onRelease,
    });

    // Gesture-bound audio unlock: some mobile browsers only honour touchend/pointerup.
    host.addEventListener('pointerup', this.unlockAudio);
    host.addEventListener('touchend', this.unlockAudio);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onHide);

    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(host);
    this.watchPixelRatio();
    this.layout();

    this.raf = requestAnimationFrame(this.frame);
  }

  setVolume(value: number): void {
    this.audio.setVolume(value);
  }

  /** Show or hide the note grid (visual only). */
  setGrid(visible: boolean): void {
    this.gridTarget = visible ? 1 : 0;
    this.wake();
  }

  /** Music Mode (the drone). Call from the button's click so audio may start. */
  setMusicMode(on: boolean, fromGesture: boolean): void {
    if (on && fromGesture) this.audio.unlock();
    this.audio.setMusicMode(on);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onPixelRatio);
    this.host.removeEventListener('pointerup', this.unlockAudio);
    this.host.removeEventListener('touchend', this.unlockAudio);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onHide);
    this.interaction.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.renderer.canvas.remove();
    disposeHaptics();
  }

  // ------------------------------------------------------------- interaction

  private onPress = (s: PointerSample): void => {
    hapticTap(s.kind);
    const note = noteAt(s.nx, s.ny, this.note);
    this.audio.unlock();
    this.audio.noteOn(heightOf(note), this.pan(s));
    this.audio.setKey(note.pitchClass);
    this.tone.play(note, true);
    this.dotWaves.touch(s.x, s.y, this.width, this.height, s.time);
    this.membrane.press(s.x, s.y, this.contactRadius(s), s.kind === 'pen' ? 0.55 + 0.6 * s.pressure : 1, s.kind);
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastT = s.time;
    this.speed = 0;
    this.host.classList.add('is-pressing');
    this.wake();
  };

  private onMove = (s: PointerSample, cause: 'pointer' | 'layout'): void => {
    const note = noteAt(s.nx, s.ny, this.note);
    this.audio.glide(heightOf(note), this.pan(s), cause === 'layout' ? GLIDE_LAYOUT : GLIDE_TOUCH);
    this.tone.play(note, false);
    this.membrane.move(s.x, s.y);
    if (cause === 'pointer') this.dotWaves.trail(s.x, s.y, this.width, this.height, s.time);

    if (cause === 'pointer') {
      const dt = (s.time - this.lastT) / 1000;
      if (dt > 0.001) {
        // Speed in viewport-lengths per second, so it feels the same on every screen.
        const instant = Math.hypot(s.x - this.lastX, s.y - this.lastY) / Math.min(this.width, this.height) / dt;
        this.speed += (instant - this.speed) * (1 - Math.exp(-dt / SPEED_TAU));
        this.lastMoveAt = s.time;
      }
    }
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastT = s.time;
  };

  private onRelease = (): void => {
    this.audio.noteOff();
    // The drone settles in the key of the note the hand last left on.
    this.audio.setKey(this.note.pitchClass);
    this.tone.release();
    this.membrane.release();
    this.dotWaves.lift();
    this.host.classList.remove('is-pressing');
  };

  private unlockAudio = (): void => this.audio.unlock();

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onHide();
  };

  private onHide = (): void => {
    this.interaction.cancel();
    this.audio.sleep();
  };

  /** Fingertip-sized: about a centimetre on a phone, a little more generous on large screens. */
  private contactRadius(s: PointerSample): number {
    const base = Math.min(Math.max(Math.min(this.width, this.height) * 0.05, 24), 42);
    if (s.kind === 'pen') return base * 0.7;
    if (s.kind === 'touch' && s.size > 4) {
      return Math.min(Math.max((base + s.size * 0.6) / 2, base * 0.8), base * 1.4);
    }
    return base;
  }

  private pan(s: PointerSample): number {
    return (s.nx - 0.5) * PAN_WIDTH;
  }

  // ------------------------------------------------------------- layout

  private layout(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    if (this.width > 1 && this.height > 1) this.membrane.resize(width / this.width, height / this.height);
    this.width = width;
    this.height = height;
    this.interaction.setBounds(rect.left, rect.top, width, height);
    this.renderer.resize(width, height, this.governor.pixelRatio(width, height));
    // Paint immediately so a rotation never shows a stretched frame.
    this.render(performance.now());
  }

  private watchPixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.onPixelRatio);
    this.dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onPixelRatio);
  }

  private onPixelRatio = (): void => {
    this.watchPixelRatio();
    this.layout();
  };

  // ------------------------------------------------------------- frame loop

  private wake(): void {
    this.lastRender = 0;
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dtMs = this.lastFrame ? now - this.lastFrame : 16.7;
    this.lastFrame = now;
    const dt = Math.min(dtMs, 100) / 1000;

    // Hand speed decays when the pointer stops sending moves.
    if (now - this.lastMoveAt > 32) this.speed *= Math.exp(-dt / SPEED_DECAY_TAU);
    this.audio.express(dt, this.interaction.pressing ? this.speed : 0);

    // Waves pass through the dots at full frame rate; only a fully still surface drops to 30 fps.
    const gridMoving = this.grid !== this.gridTarget;
    const animating = this.membrane.animating || !this.tone.settled || this.dotWaves.active || gridMoving;
    if (gridMoving) {
      this.grid += (this.gridTarget - this.grid) * (1 - Math.exp(-dt / GRID_TAU));
      if (Math.abs(this.grid - this.gridTarget) < 0.002) this.grid = this.gridTarget;
    }
    this.membrane.step(dt);
    this.tone.step(dt);
    this.dotWaves.step(dt, this.width, this.height);

    // At rest the surface only breathes, so it is drawn at a gentle 30 fps to save power.
    if (!animating && now - this.lastRender < IDLE_FRAME_MS) return;

    if (animating && dtMs < 100 && this.governor.observe(dtMs, now)) {
      this.renderer.resize(this.width, this.height, this.governor.pixelRatio(this.width, this.height));
    }
    this.render(now);
  };

  /**
   * The volume control is white on colour and turns to a soft dark ink on the
   * white membrane. Written straight to a CSS variable — no React involved —
   * and only when it visibly changes.
   */
  private syncInterfaceInk(): void {
    const p = this.tone.paleness;
    // Skip imperceptible steps, but always land exactly on the end states.
    const settled = p === 0 || p === 1;
    if (p === this.uiPaleness || (!settled && Math.abs(p - this.uiPaleness) < 0.02)) return;
    this.uiPaleness = p;
    const v = Math.round(255 - (255 - 34) * p);
    const root = document.documentElement.style;
    root.setProperty('--ui-ink', `rgb(${v}, ${v}, ${Math.round(v + 4 * p)})`);
    root.setProperty('--ui-halo', `rgba(0, 0, 0, ${(0.16 * (1 - p)).toFixed(3)})`);
  }

  private render(now: number): void {
    const frame = this.frameState;
    frame.time = ((now - this.epoch) / 1000) % 20000;
    frame.liveContacts = this.membrane.pack(this.contacts);
    frame.paleness = this.tone.paleness;
    frame.grid = this.grid;
    this.dotWaves.pack(this.waves);
    this.renderer.render(frame);
    this.syncInterfaceInk();
    this.lastRender = now;
    if (!this.revealed) {
      this.revealed = true;
      requestAnimationFrame(() => this.renderer.canvas.classList.add('is-revealed'));
    }
  }
}
