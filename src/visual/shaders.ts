import { CONTACT_STRIDE, MAX_CONTACTS } from '../physics/Membrane';
import { MAX_WAVES, WAVE_LIFT, WAVE_OPACITY, WAVE_SHIFT, WAVE_STRIDE, WAVE_WANDER } from './DotWaves';
import {
  ASYMMETRY,
  COMPRESSION,
  DRAG,
  HEIGHT_SCALE,
  DOT_ECHO,
  DOT_ECHO_LAG,
  DOT_JITTER,
  DOT_JITTER_SPEED,
  DOT_EDGE_FADE,
  GRID_DASH,
  GRID_EDGE_FADE,
  GRID_GAP,
  GRID_OPACITY,
  DOT_OPACITY,
  MAX_DOT_FADE,
  PAD_WEIGHT,
  REACH,
  RIM_AMOUNT,
  RIM_LEAD,
  RIM_RADIUS,
  RIM_WIDTH,
} from './surfaceMath';

/**
 * The membrane is rendered as a single full-screen fragment shader.
 *
 * For each screen pixel p:
 *  1. Invert the membrane's lateral displacement (three fixed-point iterations)
 *     to find the material point m that has been pushed to p. The dot grid and
 *     the shading are defined on m — so they physically bend, compress inside
 *     the dent and stretch around it.
 *  2. Evaluate the indentation height around m (centre + 4 neighbours) for a
 *     surface normal and a curvature (cavity) term, plus an analytic slow swell.
 *  3. Light the membrane's single current colour (u_tone) as a matte, slightly
 *     wrap-lit material with soft occlusion in the dent. No specular: it must
 *     read as fabric/silicone, not glass or water. Pressure only ever changes
 *     shading, never hue.
 *  4. Composite the dense dot mesh (~40%) in display space — white on colour,
 *     soft grey on the white membrane — sinking it into the material under
 *     pressure, then dither to kill banding.
 *
 * GLSL ES 1.00 for the widest WebGL support; constants come from the same
 * TypeScript modules the rest of the app uses.
 */

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

#define MAX_CONTACTS ${MAX_CONTACTS}
#define STRIDE ${CONTACT_STRIDE / 4}
#define MAX_WAVES ${MAX_WAVES}
#define WAVE_VEC4S ${WAVE_STRIDE / 4}

uniform vec2 u_view;        // viewport, CSS px
uniform float u_canvasHeight; // drawing buffer height, device px
uniform float u_pxScale;    // device px per CSS px
uniform float u_time;       // seconds
uniform float u_active;     // 1 when any contact is alive
uniform float u_dotSpacing; // CSS px
uniform float u_dotRadius;  // CSS px
uniform vec4 u_contacts[MAX_CONTACTS * STRIDE];
uniform vec3 u_tone;        // the membrane's one colour, linear sRGB
uniform float u_paleness;   // 0 on colour … 1 on the white resting membrane
uniform float u_grid;       // note grid visibility, 0…1
uniform vec4 u_waves[MAX_WAVES * WAVE_VEC4S]; // ripples through the dot mesh (see DotWaves.ts)

const float HEIGHT_SCALE = ${f(HEIGHT_SCALE)};
const float COMPRESSION = ${f(COMPRESSION)};
const float DRAG = ${f(DRAG)};
const float ASYMMETRY = ${f(ASYMMETRY)};
const float REACH = ${f(REACH)};
const float REACH2 = ${f(REACH * REACH)};
const float PAD_WEIGHT = ${f(PAD_WEIGHT)};
const float RIM_AMOUNT = ${f(RIM_AMOUNT)};
const float RIM_RADIUS = ${f(RIM_RADIUS)};
const float RIM_WIDTH = ${f(RIM_WIDTH)};
const float RIM_LEAD = ${f(RIM_LEAD)};
const float MAX_DOT_FADE = ${f(MAX_DOT_FADE)};
const float DOT_OPACITY = ${f(DOT_OPACITY)};
const float DOT_EDGE_FADE = ${f(DOT_EDGE_FADE)};
const float GRID_OPACITY = ${f(GRID_OPACITY)};
const float GRID_DASH = ${f(GRID_DASH)};
const float GRID_GAP = ${f(GRID_GAP)};
const float GRID_EDGE_FADE = ${f(GRID_EDGE_FADE)};
const float WAVE_SHIFT = ${f(WAVE_SHIFT)};
const float WAVE_OPACITY = ${f(WAVE_OPACITY)};
const float WAVE_LIFT = ${f(WAVE_LIFT)};
const float WAVE_WANDER = ${f(WAVE_WANDER)};
const float DOT_JITTER = ${f(DOT_JITTER)};
const float DOT_JITTER_SPEED = ${f(DOT_JITTER_SPEED)};
const float DOT_ECHO = ${f(DOT_ECHO)};
const float DOT_ECHO_LAG = ${f(DOT_ECHO_LAG)};

// Key light from the upper left, fairly high: long soft gradients, no hard terminator.
const vec3 LIGHT = vec3(-0.46, -0.62, 0.64);
const float WRAP = 0.32;

// ---------------------------------------------------------------- colour

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ---------------------------------------------------------------- membrane

float sigm(float x) { return x * inversesqrt(1.0 + x * x); }

// Every contact's influence fades to exactly zero before the REACH cut-off, measured
// in plain distance. Without it, a dent stretched by fast motion would still be
// slightly deep where it is cut off, leaving a hairline circular crease.
float reachWindow(vec2 d, float a) {
  return 1.0 - smoothstep(0.6 * REACH, REACH, length(d) / a);
}

float profile(float r) {
  float r2 = r * r;
  float pad = 1.0 / (1.0 + r2 * r2);
  float tension = 1.0 / (1.0 + 0.8 * r2);
  return (PAD_WEIGHT * pad + (1.0 - PAD_WEIGHT) * tension) * (1.0 - smoothstep(3.5, 6.5, r));
}

// Normalised radius in the contact's own frame: elliptical (fingertip),
// asymmetric along the motion, with a softly irregular contour.
// 'ahead' receives the cosine toward the motion, scaled by its strength.
float contactRadius(vec2 d, vec4 c0, vec4 c1, vec4 c2, vec4 c3, out float ahead) {
  float a = c0.w;
  float sa = sqrt(c1.z);
  vec2 e = vec2(dot(d, c1.xy) / sa, (c1.x * d.y - c1.y * d.x) * sa) / a;
  float fwd = dot(d, c2.xy) / a;
  e *= exp(ASYMMETRY * sigm(1.3 * fwd));
  float rr = dot(e, e) + 1e-6;
  float ir = inversesqrt(rr);
  float cx = e.x * ir;
  float sx = e.y * ir;
  float c2a = cx * cx - sx * sx;
  float s2a = 2.0 * cx * sx;
  float c3a = c2a * cx - s2a * sx;
  float s3a = s2a * cx + c2a * sx;
  float irregular = 1.0 + c2a * c3.x + s2a * c3.y + c3a * c3.z + s3a * c3.w;
  ahead = fwd / max(length(d) / a, 1e-3);
  return sqrt(rr) / irregular;
}

// Lateral displacement of material point q (forward map).
vec2 displacement(vec2 q) {
  vec2 D = vec2(0.0);
  for (int i = 0; i < MAX_CONTACTS; i++) {
    vec4 c0 = u_contacts[i * STRIDE];
    if (abs(c0.z) < 1e-4) continue;
    vec2 d = q - c0.xy;
    if (dot(d, d) > REACH2 * c0.w * c0.w) continue;
    vec4 c1 = u_contacts[i * STRIDE + 1];
    vec4 c2 = u_contacts[i * STRIDE + 2];
    vec4 c3 = u_contacts[i * STRIDE + 3];
    float ahead;
    float r = contactRadius(d, c0, c1, c2, c3, ahead);
    D += (-d * (COMPRESSION * c0.z * profile(r)) + c2.xy * (c0.w * DRAG * c0.z * exp(-0.4 * r * r))) * reachWindow(d, c0.w);
  }
  return D;
}

// Height (CSS px, negative = pressed in) of material point q.
float heightAt(vec2 q) {
  float h = 0.0;
  for (int i = 0; i < MAX_CONTACTS; i++) {
    vec4 c0 = u_contacts[i * STRIDE];
    if (abs(c0.z) < 1e-4) continue;
    vec2 d = q - c0.xy;
    if (dot(d, d) > REACH2 * c0.w * c0.w) continue;
    vec4 c1 = u_contacts[i * STRIDE + 1];
    vec4 c2 = u_contacts[i * STRIDE + 2];
    vec4 c3 = u_contacts[i * STRIDE + 3];
    float ahead;
    float r = contactRadius(d, c0, c1, c2, c3, ahead);
    float rim = RIM_AMOUNT * (1.0 + RIM_LEAD * max(ahead, 0.0)) * (1.0 - 0.5 * max(-ahead, 0.0))
              * exp(-(r - RIM_RADIUS) * (r - RIM_RADIUS) * RIM_WIDTH);
    h -= c0.z * (profile(r) - rim) * HEIGHT_SCALE * c0.w * reachWindow(d, c0.w);
  }
  return h;
}

// Centre sample: also accumulates pressure (for colour/occlusion) and dot fade.
float heightAtCentre(vec2 q, out float pressure, out float fade) {
  float h = 0.0;
  pressure = 0.0;
  fade = 0.0;
  for (int i = 0; i < MAX_CONTACTS; i++) {
    vec4 c0 = u_contacts[i * STRIDE];
    vec4 c1 = u_contacts[i * STRIDE + 1];
    if (abs(c0.z) < 1e-4 && c1.w < 1e-3) continue;
    vec2 d = q - c0.xy;
    if (dot(d, d) > REACH2 * c0.w * c0.w) continue;
    vec4 c2 = u_contacts[i * STRIDE + 2];
    vec4 c3 = u_contacts[i * STRIDE + 3];
    float ahead;
    float r = contactRadius(d, c0, c1, c2, c3, ahead);
    float p = profile(r);
    float rim = RIM_AMOUNT * (1.0 + RIM_LEAD * max(ahead, 0.0)) * (1.0 - 0.5 * max(-ahead, 0.0))
              * exp(-(r - RIM_RADIUS) * (r - RIM_RADIUS) * RIM_WIDTH);
    float w = reachWindow(d, c0.w);
    h -= c0.z * (p - rim) * HEIGHT_SCALE * c0.w * w;
    pressure += c0.z * p * w;
    fade += c1.w * (1.0 - smoothstep(0.3, 1.6, r));
  }
  return h;
}

// Very slow, long, near-horizontal swells: the idle surface breathes like a calm sea.
// Returns (height, dh/dx, dh/dy) in CSS px.
vec3 swell(vec2 q, float t) {
  vec3 acc = vec3(0.0);
  vec2 k1 = vec2(0.0011, 0.0062);
  vec2 k2 = vec2(-0.0019, 0.0043);
  vec2 k3 = vec2(0.0031, 0.0027);
  float a1 = dot(k1, q) + 0.31 * t;
  float a2 = dot(k2, q) - 0.23 * t + 1.7;
  float a3 = dot(k3, q) + 0.17 * t + 4.1;
  acc += vec3(sin(a1), cos(a1) * k1) * 3.0;
  acc += vec3(sin(a2), cos(a2) * k2) * 2.4;
  acc += vec3(sin(a3), cos(a3) * k3) * 1.6;
  return acc;
}

// Per-dot randomness: one hash per dot, shared by its shiver, ghost and ripple wander.
vec4 dotRandom(vec2 cell) {
  vec4 h = vec4(hash12(cell + 3.17), hash12(cell * 1.31 + 7.73), 0.0, 0.0);
  h.zw = fract(h.xy * vec2(7.31, 5.17) + h.yx * 3.11);
  return h;
}

// Each dot shivers on its own: two incommensurate sines per axis with phases and
// rates from its random values, so the mesh shimmers without ever moving in step.
vec2 dotJitter(vec4 h, float t) {
  vec2 phase = h.xy * 6.2831853;
  vec2 rate = (1.0 + h.zw * 0.8) * DOT_JITTER_SPEED;
  return vec2(
    sin(t * rate.x + phase.x) + 0.55 * sin(t * rate.y * 1.73 + phase.y),
    sin(t * rate.y * 1.11 + phase.y + 1.3) + 0.55 * sin(t * rate.x * 1.57 + phase.x)
  ) / 1.55;
}

// Ripples through the mesh (see DotWaves.ts): edge and touch rings, and the
// moving finger's wake — soft packets (short lead, strong centre, long falloff)
// that move dots along the ripple, plus a little in each dot's own random
// direction, and lift their opacity. A pure function of the current rings:
// nothing accumulates, so a dot is exactly at rest once a ring has passed.
// Only the dots read this.
//
// Ripples are far wider than the dot spacing, so the field is evaluated once per
// pixel and shared by the neighbouring dots it draws. It is returned as sums the
// dots combine with their own wander:
//   radial   Σ s·sin(φ)·r̂        cs  (Σ s·cos φ, Σ s·sin φ)        opacity factor
struct Ripple {
  vec2 radial;
  vec2 cs;
  float opacity;
};

Ripple ripplesAt(vec2 g) {
  Ripple r;
  r.radial = vec2(0.0);
  r.cs = vec2(0.0);
  r.opacity = 1.0;
  for (int i = 0; i < MAX_WAVES; i++) {
    vec4 a = u_waves[i * WAVE_VEC4S];
    if (a.w <= 0.0) continue;
    vec4 b = u_waves[i * WAVE_VEC4S + 1];
    vec2 rel = g - a.xy;
    float dist = max(length(rel), 1e-3);
    float d = dist - a.z;
    // Most rings are nowhere near most pixels: skip them before any real work.
    if (abs(d) > 3.0 * max(b.y, b.z)) continue;
    float width = d > 0.0 ? b.y : b.z;
    float s = a.w * exp(-(d * d) / (width * width));
    float phase = 6.2831853 * d / b.x;
    float sn = sin(phase);
    float cn = cos(phase);
    r.radial += (rel / dist) * (s * sn);
    r.cs += s * vec2(cn, sn);
    r.opacity += s * (WAVE_LIFT + WAVE_OPACITY * cn);
  }
  r.opacity = clamp(r.opacity, 0.2, 2.0);
  return r;
}

// One dot of the mesh — rest position, ripple, shiver and ghost — as seen from g.
// Returns coverage × the ripple's opacity factor.
float dotAt(vec2 g, float col, float row, float aa, Ripple ripple) {
  float offset = mod(row, 2.0) * 0.5 * u_dotSpacing;
  vec2 centre = vec2(col * u_dotSpacing + offset, row * u_dotSpacing * 0.8660254);
  vec4 h = dotRandom(vec2(col, row));
  // Ripple: along the ring, plus this dot's own wander, phase-offset per dot:
  // cos(φ + k) = cos φ cos k − sin φ sin k.
  vec2 wander = h.zw * 2.0 - 1.0;
  float k = wander.x * 2.0;
  float own = ripple.cs.x * cos(k) - ripple.cs.y * sin(k);
  centre += (ripple.radial + wander * (WAVE_WANDER * own)) * (WAVE_SHIFT * u_dotSpacing);
  float amp = u_dotSpacing * DOT_JITTER;
  vec2 now = centre + dotJitter(h, u_time) * amp;
  // A faint ghost where the dot just was, as in a long exposure.
  vec2 then = centre + dotJitter(h, u_time - DOT_ECHO_LAG) * amp;
  float body = 1.0 - smoothstep(u_dotRadius - aa, u_dotRadius + aa, length(g - now));
  float ghost = 1.0 - smoothstep(u_dotRadius - aa, u_dotRadius + aa, length(g - then));
  return max(body, ghost * DOT_ECHO) * ripple.opacity;
}

// Ripples can carry a dot across its cell boundary, so the pixel looks at the
// nearest dot plus its closest neighbours in its own row and the adjacent row.
float dotCoverage(vec2 m, float pressure) {
  float rowH = u_dotSpacing * 0.8660254;
  vec2 g = m - u_view * 0.5;
  float rowF = g.y / rowH;
  float row = floor(rowF + 0.5);
  float colF = (g.x - mod(row, 2.0) * 0.5 * u_dotSpacing) / u_dotSpacing;
  float col = floor(colF + 0.5);
  float side = colF >= col ? 1.0 : -1.0;
  float row2 = row + (rowF >= row ? 1.0 : -1.0);
  float col2 = floor((g.x - mod(row2, 2.0) * 0.5 * u_dotSpacing) / u_dotSpacing + 0.5);
  // One screen pixel measured in material units grows where the material is compressed.
  float aa = 0.7 / (u_pxScale * max(1.0 - COMPRESSION * pressure, 0.5));
  Ripple ripple = ripplesAt(g);
  float own = dotAt(g, col, row, aa, ripple);
  // Neighbours can only reach this pixel when a ripple pushes them far enough;
  // elsewhere (most of the surface, most of the time) one dot is all there is.
  float reach = (length(ripple.radial) + WAVE_WANDER * length(ripple.cs)) * WAVE_SHIFT * u_dotSpacing
              + DOT_JITTER * u_dotSpacing + u_dotRadius + aa;
  if (reach < 0.42 * rowH) return own;
  return max(own, max(dotAt(g, col + side, row, aa, ripple), dotAt(g, col2, row2, aa, ripple)));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvasHeight - gl_FragCoord.y) / u_pxScale;

  vec2 m = p;
  float h = 0.0;
  float pressure = 0.0;
  float fade = 0.0;
  vec2 grad = vec2(0.0);
  float lap = 0.0;

  if (u_active > 0.5) {
    m = p - displacement(p);
    m = p - displacement(m);
    m = p - displacement(m);

    h = heightAtCentre(m, pressure, fade);
    const float E = 1.0;
    float hx1 = heightAt(m + vec2(E, 0.0));
    float hx0 = heightAt(m - vec2(E, 0.0));
    float hy1 = heightAt(m + vec2(0.0, E));
    float hy0 = heightAt(m - vec2(0.0, E));
    grad = vec2(hx1 - hx0, hy1 - hy0) / (2.0 * E);
    lap = (hx1 + hx0 + hy1 + hy0 - 4.0 * h) / (E * E);
  }

  vec3 sw = swell(m, u_time);
  grad += sw.yz;

  // Matte, wrap-lit material. Normalised so an undisturbed surface is exactly 1.
  vec3 n = normalize(vec3(-grad, 1.0));
  vec3 L = normalize(LIGHT);
  float diffuse = max((dot(n, L) + WRAP) / (L.z + WRAP), 0.0);
  // Soft occlusion: the bottom of the dent sees less of the sky; concave
  // curvature darkens a little more, convex (the rim) catches a touch of light.
  float occlusion = 1.0 - 0.13 * clamp(pressure, 0.0, 1.3) - clamp(lap * 2.0, -0.04, 0.1);

  vec2 v = p / u_view - 0.5;
  float vignette = 1.0 - mix(0.08, 0.035, u_paleness) * smoothstep(0.08, 0.5, dot(v, v));

  float light = diffuse * occlusion * vignette * (1.0 + sw.x * 0.0016);
  vec3 toneSrgb = toSrgb(u_tone);
  vec3 srgb = toSrgb(u_tone * light);

  // Dots are part of the material: they share its light and sink into it under pressure.
  // White marks vanish on a white membrane, so there the ink becomes a darker shade of the tone.
  vec3 ink = mix(vec3(1.0), toneSrgb * 0.62, u_paleness) * sqrt(light);
  // The mesh fades into the left and right edges of the screen (dots only):
  // smoothstep has zero slope where the fade begins, so there is no visible boundary.
  float sx = p.x / u_view.x;
  float edges = smoothstep(0.0, DOT_EDGE_FADE, sx) * smoothstep(0.0, DOT_EDGE_FADE, 1.0 - sx);
  float dots = dotCoverage(m, pressure) * DOT_OPACITY * edges * (1.0 - MAX_DOT_FADE * clamp(fade, 0.0, 1.0));
  srgb = mix(srgb, ink, dots);

  // Note grid: a 1 px line exactly on every semitone of the horizontal pitch axis,
  // in screen space (it marks where the finger plays, not the bent material).
  // Every line has the same opacity; sharps are dashed. The grid fades out over
  // the top and bottom 20% of the screen. Same ink as the dots.
  if (u_grid > 0.001) {
    float k = floor(p.x / u_view.x * 12.0 + 0.5);
    // C and C′ sit on the screen edges: keep their full pixel inside the screen.
    float lineX = clamp(k * u_view.x / 12.0, 0.5, u_view.x - 0.5);
    float cover = clamp(0.5 * u_pxScale + 0.5 - abs(p.x - lineX) * u_pxScale, 0.0, 1.0);
    float pc = mod(k, 12.0);
    float sharp = (abs(pc - 1.0) < 0.5 || abs(pc - 3.0) < 0.5 || abs(pc - 6.0) < 0.5
                || abs(pc - 8.0) < 0.5 || abs(pc - 10.0) < 0.5) ? 1.0 : 0.0;
    // Dashes, anti-aliased at their ends, in CSS px along the line.
    float period = GRID_DASH + GRID_GAP;
    float along = mod(p.y, period);
    float edgeAa = 0.5 / u_pxScale;
    float dash = smoothstep(-edgeAa, edgeAa, along) * (1.0 - smoothstep(GRID_DASH - edgeAa, GRID_DASH + edgeAa, along));
    cover *= mix(1.0, dash, sharp);
    float sy = p.y / u_view.y;
    float fadeY = smoothstep(0.0, GRID_EDGE_FADE, sy) * smoothstep(0.0, GRID_EDGE_FADE, 1.0 - sy);
    vec3 gridInk = mix(vec3(1.0), toneSrgb * 0.55, u_paleness);
    srgb = mix(srgb, gridInk, cover * GRID_OPACITY * fadeY * u_grid);
  }

  // Triangular dither, ±1 LSB: smooth gradients without banding.
  vec2 seed = gl_FragCoord.xy + fract(u_time * 7.13) * 61.0;
  srgb += (hash12(seed) + hash12(seed + 17.31) - 1.0) / 255.0;

  gl_FragColor = vec4(srgb, 1.0);
}
`;
