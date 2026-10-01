# Sea

A soft, continuous musical membrane. Touch it, press it, glide across it.

- **Horizontal → continuous pitch (the note).** One octave across the full width, C at the left edge to C′ at the right. No keys, zones, snapping or rounding: every position is its own pitch, and a few pixels are a few cents.
- **Vertical → continuous octave.** A linear, analog register fader over three octaves, from bottom (lowest, darkest) to top (highest, brightest): pitch = C2 + note + 12 × octave. Equal movement is an equal change in pitch everywhere — no octave sections or steps.
- These axes hold in every orientation; rotating the device only re-fits the surface.
- **One colour at a time.** At rest the membrane is white. While playing, the whole surface
  takes the colour of the note: each note owns one hue (C red … B magenta, continuously
  interpolated for microtones), and the octave only deepens or lightens it. Colour diffuses
  in OKLab. When the finger lifts, the colour of the last note stays for 5 seconds, then
  eases back to white; touching again in the meantime simply takes over.
- A dense, staggered dot mesh (~40%) is embedded in the material: white on colour, soft grey
  on white. Each dot shivers on its own with a faint ghost trail. Now and then a ripple enters
  from a random edge — like a fingertip touching still water just off-screen — and spreads
  across the mesh, moving the dots and lifting their opacity as it passes (randomised edge,
  timing, speed, width and strength; dots only, nothing accumulates). Every touch or click
  sends the same kind of ripple out from the fingertip, and a moving finger leaves a wake of
  small rings along its path — stronger the faster it moves. Over the outer 20% at the left
  and right edges the dots fade smoothly into the surface.
- **Note grid** (the ruler button): a 1 px line exactly on every semitone of the pitch axis,
  all at the same opacity, with the sharps dashed; it fades out over the top and bottom 20%
  — white on colour, soft grey on white.
- **Music Mode** (the two-note button): a soft ambient bed in the key of the last played
  note — a blurred saw pad, a sine body, glassy triangles, randomly blooming high shimmer
  and breathing air noise. Its octave never changes: small key moves glide, larger ones
  cross-fade between chords. The mesh bends with
  the membrane and sinks under the fingertip.

```
npm install
npm run dev        # http://localhost:5180 (also exposed on the LAN for phones)
npm run build      # typecheck + production build
npm test           # mapping, palette and physics invariants
```

## Architecture

```
src/
  music/pitch.ts              coordinate → note (continuous pitch class) + continuous octave → pitch
  interaction/
    InteractionEngine.ts      single-pointer tracking, capture, cancel paths → press/move/release
    haptics.ts                one subtle tap on first contact (Vibration API / iOS switch haptic)
  physics/Membrane.ts         contacts as damped springs: follow, depth, lead, axis, dot fade
  audio/
    Voice.ts                  squares + sine → filter → soft saturation → tracked low-pass → EQ → amp
    Drone.ts                  Music Mode: the ambient bed in the key of the last note, fixed octave
    space.ts                  synthesized dark impulse-response reverb + ping-pong echoes fed into it
    AudioEngine.ts            context lifecycle, monophonic voice with overlapping release tails
  visual/
    palette.ts                pitch → colour: OKLCH hue anchors, Catmull-Rom, lightness, gamut mapping
    Tone.ts                   the membrane's single evolving colour (white ↔ current pitch)
    DotWaves.ts               ripples entering from the edges through the dot mesh (dots only)
    surfaceMath.ts            indentation shape constants (shared with GLSL) + CPU mirror
    shaders.ts                full-screen fragment shader, generated from the TS constants
    WebGLSurface.ts           WebGL2/WebGL1 renderer, context-loss recovery
    CanvasSurface.ts          Canvas 2D fallback
    quality.ts                pixel budget + adaptive resolution
  instrument/Instrument.ts    wires everything; one rAF loop; resize/orientation/visibility
  ui/                         VolumeControl, ToggleButton (grid, Music Mode) — the only UI
```

High-frequency work never goes through React: pointer events drive audio directly in the
native handler (lowest latency); a single `requestAnimationFrame` loop steps the physics
and renders. React owns only the two controls. The interaction, physics and render paths
allocate nothing per frame or per pointer event (reused samples, notes, frame state, buffers
and pooled ripple objects), so garbage collection never interrupts a gesture. On the GPU the
ripple field is evaluated once per pixel and neighbouring dots are only examined where a
ripple can actually reach them. Render resolution starts from a per-device pixel budget and
steps down automatically if frames run long.

### How the surface works

Each pixel inverts the membrane's lateral displacement to find the *material point* that
was pushed there; shading and the dot mesh are defined on that material point, so they bend,
compress inside the dent and stretch around it. Height around the point gives normals and
curvature for matte, wrap-lit shading with soft occlusion. The indentation profile is a flat
fingertip pad plus a long tension tail and a faint displaced-material rim. The shape is an
irregular ellipse that turns toward the motion, is steeper ahead of it and stretched behind.

### Tuning

Most of the feel lives in a few constant blocks: `Membrane.ts` (spring constants),
`surfaceMath.ts` (indentation shape), `palette.ts` / `Tone.ts` (colour and its easing), `Voice.ts` (timbre, envelopes),
`space.ts` (room), `music/pitch.ts` (range).

## Platform notes

- Browsers only allow audio after a user activation. On touch devices the first activation is
  `touchend`, so the very first touch of a session may wake the instrument rather than sound
  fully. Every touch after that plays immediately.
- Haptics: Android uses the Vibration API. iOS has no Vibration API; on iOS 18+ a hidden
  switch control is toggled for the system haptic (best effort).
- On iOS the audio session is set to `playback`, so the instrument still sounds with the ringer switch on silent.
