/**
 * Physical state of the membrane: a handful of "contacts" — places where a
 * fingertip is pressing, or recently pressed and is still recovering.
 *
 * Each contact is a small set of damped springs:
 *   position  follows the finger quickly, with a hair of inertia
 *   depth     presses in firmly, recovers with soft (barely underdamped) elasticity
 *   lead      smoothed velocity → directional stretch and the fold ahead of motion
 *   axis      fingertip ellipse orientation, turning toward the motion when moving
 *   fade      how far the dots have sunk into the material — follows depth, so dots
 *             re-emerge with exactly the surface's own damping
 *
 * The visual shape of the indentation is evaluated on the GPU from this state
 * (see visual/shaders.ts). Units are CSS pixels and seconds.
 */

export const MAX_CONTACTS = 4;
/** Floats per contact in the packed uniform buffer (4 × vec4). */
export const CONTACT_STRIDE = 16;

export type ContactKind = 'mouse' | 'pen' | 'touch';

const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 16;

const FOLLOW = { omega: 62, zeta: 0.92 };
const PRESS = { omega: 30, zeta: 0.95 };
const RECOVER = { omega: 10.5, zeta: 0.76 };

const LEAD_TAU = 0.07;
const LEAD_SCALE = 10; // radii per second for a "full" directional stretch
const AXIS_TAU = 0.09;

/** Amplitudes of the 2nd and 3rd angular harmonics that make the contour organic. */
const IRREGULARITY_2 = 0.06;
const IRREGULARITY_3 = 0.035;

const REST = 5e-4;

class Contact {
  alive = false;
  pressed = false;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  tx = 0;
  ty = 0;
  radius = 1;

  depth = 0;
  depthV = 0;
  depthTarget = 0;

  leadX = 0;
  leadY = 0;

  // Ellipse orientation stored as a doubled angle (cos 2θ, sin 2θ): an ellipse
  // is symmetric under 180° rotation, so this blends without flipping.
  axisC = 1;
  axisS = 0;
  restC = 1;
  restS = 0;
  aspectBase = 1;
  aspect = 1;

  phase2 = 0;
  phase3 = 0;
  fade = 0;

  get strength(): number {
    return Math.abs(this.depth) + this.fade + Math.hypot(this.leadX, this.leadY);
  }
}

export class Membrane {
  private readonly contacts: Contact[] = Array.from({ length: MAX_CONTACTS }, () => new Contact());
  private active: Contact | null = null;
  private random = mulberry32(0x5ea);

  /** True while anything is pressed, moving or still recovering. */
  get animating(): boolean {
    for (let i = 0; i < MAX_CONTACTS; i++) if (this.contacts[i].alive) return true;
    return false;
  }

  press(x: number, y: number, radius: number, strength: number, kind: ContactKind): void {
    this.release();
    const contact = this.claim(x, y, radius);
    const fresh = !contact.alive;

    contact.alive = true;
    contact.pressed = true;
    contact.tx = x;
    contact.ty = y;
    contact.depthTarget = strength;
    contact.radius = radius;

    if (fresh) {
      const r = this.random;
      contact.x = x;
      contact.y = y;
      contact.vx = contact.vy = 0;
      contact.depth = contact.depthV = 0;
      contact.leadX = contact.leadY = 0;
      contact.fade = 0;
      // A fingertip pad is an ellipse leaning roughly along the finger; a mouse
      // "fingertip" is rounder and has no preferred direction.
      const angle = kind === 'touch' ? 1.75 + (r() - 0.5) * 0.5 : r() * Math.PI;
      contact.restC = Math.cos(2 * angle);
      contact.restS = Math.sin(2 * angle);
      contact.axisC = contact.restC;
      contact.axisS = contact.restS;
      contact.aspectBase = kind === 'touch' ? 1.18 + r() * 0.1 : kind === 'pen' ? 1.04 : 1.07 + r() * 0.06;
      contact.aspect = contact.aspectBase;
      contact.phase2 = r() * Math.PI * 2;
      contact.phase3 = r() * Math.PI * 2;
    }
    this.active = contact;
  }

  move(x: number, y: number): void {
    if (!this.active) return;
    this.active.tx = x;
    this.active.ty = y;
  }

  /** The finger leaves; the contact keeps its last target and recovers. */
  release(): void {
    const c = this.active;
    if (!c) return;
    c.pressed = false;
    c.depthTarget = 0;
    this.active = null;
  }

  /** Keeps every contact at the same relative place when the viewport changes shape. */
  resize(scaleX: number, scaleY: number): void {
    for (const c of this.contacts) {
      if (!c.alive) continue;
      c.x *= scaleX;
      c.y *= scaleY;
      c.tx *= scaleX;
      c.ty *= scaleY;
    }
  }

  step(dt: number): void {
    if (dt <= 0) return;
    const steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / SUBSTEP));
    const h = dt / steps;

    for (const c of this.contacts) {
      if (!c.alive) continue;
      const startX = c.x;
      const startY = c.y;
      const depthSpring = c.pressed ? PRESS : RECOVER;

      for (let i = 0; i < steps; i++) {
        // Semi-implicit Euler on damped springs: stable at these stiffnesses with 240 Hz substeps.
        const w = FOLLOW.omega;
        c.vx += (w * w * (c.tx - c.x) - 2 * FOLLOW.zeta * w * c.vx) * h;
        c.vy += (w * w * (c.ty - c.y) - 2 * FOLLOW.zeta * w * c.vy) * h;
        c.x += c.vx * h;
        c.y += c.vy * h;

        const d = depthSpring.omega;
        c.depthV += (d * d * (c.depthTarget - c.depth) - 2 * depthSpring.zeta * d * c.depthV) * h;
        c.depth += c.depthV * h;
      }

      // Directional stretch: velocity measured in radii/second, softly saturated.
      const speed = Math.hypot(c.vx, c.vy) / (c.radius * LEAD_SCALE);
      const gain = speed > 1e-6 ? (Math.tanh(speed) * 0.9) / (speed * c.radius * LEAD_SCALE) : 0;
      const kLead = 1 - Math.exp(-dt / LEAD_TAU);
      c.leadX += (c.vx * gain - c.leadX) * kLead;
      c.leadY += (c.vy * gain - c.leadY) * kLead;

      // Orientation: at rest the fingertip's own angle, in motion the direction of travel.
      const lead = Math.hypot(c.leadX, c.leadY);
      const motion = smoothstep(0.08, 0.45, lead);
      let tc = c.restC;
      let ts = c.restS;
      if (motion > 0) {
        const inv = 1 / (lead * lead);
        tc += ((c.leadX * c.leadX - c.leadY * c.leadY) * inv - tc) * motion;
        ts += (2 * c.leadX * c.leadY * inv - ts) * motion;
      }
      const kAxis = 1 - Math.exp(-dt / AXIS_TAU);
      c.axisC += (tc - c.axisC) * kAxis;
      c.axisS += (ts - c.axisS) * kAxis;
      c.aspect = Math.min(c.aspectBase + 0.28 * lead, 1.5);

      // The contour slowly evolves with time and with distance travelled.
      const travelled = Math.hypot(c.x - startX, c.y - startY) / c.radius;
      c.phase2 += dt * 0.11 + travelled * 0.05;
      c.phase3 -= dt * 0.07 + travelled * 0.04;

      c.fade = Math.min(Math.max(c.depth, 0), 1);

      if (
        !c.pressed &&
        Math.abs(c.depth) < REST &&
        Math.abs(c.depthV) < REST * 10 &&
        c.fade < REST * 4 &&
        lead < REST
      ) {
        c.alive = false;
        c.depth = c.depthV = c.fade = c.leadX = c.leadY = 0;
      }
    }
  }

  /**
   * Writes contact state into a flat buffer for the renderer. Layout per contact:
   *   [x, y, depth, radius] [axisX, axisY, aspect, fade] [leadX, leadY, 0, 0]
   *   [a2·cos φ2, a2·sin φ2, a3·cos φ3, a3·sin φ3]
   * Dead contacts are zeroed. Returns the number of live contacts.
   */
  pack(out: Float32Array): number {
    let live = 0;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const c = this.contacts[i];
      const o = i * CONTACT_STRIDE;
      if (!c.alive) {
        out.fill(0, o, o + CONTACT_STRIDE);
        continue;
      }
      live++;
      const half = Math.atan2(c.axisS, c.axisC) / 2;
      out[o] = c.x;
      out[o + 1] = c.y;
      out[o + 2] = c.depth;
      out[o + 3] = c.radius;
      out[o + 4] = Math.cos(half);
      out[o + 5] = Math.sin(half);
      out[o + 6] = c.aspect;
      out[o + 7] = c.fade;
      out[o + 8] = c.leadX;
      out[o + 9] = c.leadY;
      out[o + 10] = 0;
      out[o + 11] = 0;
      out[o + 12] = IRREGULARITY_2 * Math.cos(c.phase2);
      out[o + 13] = IRREGULARITY_2 * Math.sin(c.phase2);
      out[o + 14] = IRREGULARITY_3 * Math.cos(c.phase3);
      out[o + 15] = IRREGULARITY_3 * Math.sin(c.phase3);
    }
    return live;
  }

  /**
   * Pressing where the material is still recovering re-uses that dent, so the
   * surface stays continuous instead of stacking two indentations.
   * Otherwise take a free slot, or recycle the faintest one.
   */
  private claim(x: number, y: number, radius: number): Contact {
    let best: Contact | null = null;
    let bestDistance = Infinity;
    for (const c of this.contacts) {
      if (!c.alive) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < radius * 1.2 && d < bestDistance) {
        best = c;
        bestDistance = d;
      }
    }
    if (best) return best;

    const free = this.contacts.find((c) => !c.alive);
    if (free) return free;

    let weakest = this.contacts[0];
    for (const c of this.contacts) if (c.strength < weakest.strength) weakest = c;
    weakest.alive = false;
    return weakest;
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
