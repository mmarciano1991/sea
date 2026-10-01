import { clamp01 } from '../music/pitch';

export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface PointerSample {
  /** CSS px within the surface, clamped to it. */
  x: number;
  y: number;
  /** 0 left … 1 right. */
  nx: number;
  /** 0 bottom … 1 top. */
  ny: number;
  /** 0…1, meaningful for pens only. */
  pressure: number;
  /** Reported contact diameter in CSS px (0 if unknown). */
  size: number;
  kind: PointerKind;
  /** ms, performance.now() timebase. */
  time: number;
}

/** Handlers receive a reused sample: read it synchronously, copy anything kept. */
export interface InteractionHandlers {
  press(sample: PointerSample): void;
  /** `layout` moves come from the surface changing shape under a still finger (e.g. rotation). */
  move(sample: PointerSample, cause: 'pointer' | 'layout'): void;
  release(): void;
}

/**
 * Tracks the single pointer that plays the instrument. Extra fingers are
 * ignored. Pointer capture keeps the note alive when the pointer leaves the
 * surface; every way a pointer can disappear (up, cancel, lost capture, blur,
 * page hidden) funnels into exactly one release, so notes never stick.
 *
 * Deliberately state-light and React-free: handlers are called synchronously
 * from the native events for the lowest possible latency.
 */
export class InteractionEngine {
  private pointerId: number | null = null;
  private left = 0;
  private top = 0;
  private width = 1;
  private height = 1;
  private clientX = 0;
  private clientY = 0;
  private pressure = 0.5;
  private size = 0;
  private kind: PointerKind = 'mouse';
  private readonly current: PointerSample = { x: 0, y: 0, nx: 0, ny: 0, pressure: 0, size: 0, kind: 'mouse', time: 0 };
  private readonly element: HTMLElement;
  private readonly handlers: InteractionHandlers;

  constructor(element: HTMLElement, handlers: InteractionHandlers) {
    this.element = element;
    this.handlers = handlers;
    const active = { passive: false } as const;
    element.addEventListener('pointerdown', this.onDown, active);
    element.addEventListener('pointermove', this.onMove, active);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onUp);
    element.addEventListener('lostpointercapture', this.onUp);
    // Block the browser's own touch behaviours: long-press callouts, double-tap zoom, gestures.
    element.addEventListener('touchstart', this.prevent, active);
    element.addEventListener('touchmove', this.prevent, active);
    element.addEventListener('contextmenu', this.prevent);
    element.addEventListener('dblclick', this.prevent);
    document.addEventListener('gesturestart', this.prevent, active);
    window.addEventListener('blur', this.cancel);
  }

  get pressing(): boolean {
    return this.pointerId !== null;
  }

  /** The surface changed size. A held finger is re-mapped onto the new geometry. */
  setBounds(left: number, top: number, width: number, height: number): void {
    this.left = left;
    this.top = top;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.pointerId !== null) this.handlers.move(this.sample(), 'layout');
  }

  /** Ends the current touch, if any (blur, page hidden, teardown). */
  cancel = (): void => {
    const id = this.pointerId;
    if (id === null) return;
    this.pointerId = null;
    try {
      if (this.element.hasPointerCapture(id)) this.element.releasePointerCapture(id);
    } catch {
      /* pointer already gone */
    }
    this.handlers.release();
  };

  dispose(): void {
    this.cancel();
    const el = this.element;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('lostpointercapture', this.onUp);
    el.removeEventListener('touchstart', this.prevent);
    el.removeEventListener('touchmove', this.prevent);
    el.removeEventListener('contextmenu', this.prevent);
    el.removeEventListener('dblclick', this.prevent);
    document.removeEventListener('gesturestart', this.prevent);
    window.removeEventListener('blur', this.cancel);
  }

  private onDown = (event: PointerEvent): void => {
    if (this.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.record(event);
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety; up/cancel still release */
    }
    this.handlers.press(this.sample());
  };

  private onMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.record(event);
    this.handlers.move(this.sample(), 'pointer');
  };

  private onUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.handlers.release();
  };

  private prevent = (event: Event): void => {
    if (event.cancelable) event.preventDefault();
  };

  private record(event: PointerEvent): void {
    this.clientX = event.clientX;
    this.clientY = event.clientY;
    this.kind = event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse';
    this.pressure = event.pressure;
    this.size = this.kind === 'touch' ? Math.max(event.width, event.height) : 0;
  }

  /**
   * The current pointer state. One object is reused for every event — handlers
   * must read it synchronously and copy what they keep.
   */
  private sample(): PointerSample {
    const s = this.current;
    const nx = clamp01((this.clientX - this.left) / this.width);
    const ny = clamp01((this.clientY - this.top) / this.height);
    s.x = nx * this.width;
    s.y = ny * this.height;
    s.nx = nx;
    s.ny = 1 - ny;
    s.pressure = this.pressure;
    s.size = this.size;
    s.kind = this.kind;
    s.time = performance.now();
    return s;
  }
}
