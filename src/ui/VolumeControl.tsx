import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { glyph, VOLUME_DOWN, VOLUME_OFF, VOLUME_UP } from './icons';

interface VolumeControlProps {
  value: number;
  onChange(value: number): void;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * A quiet speaker glyph and a hairline slider. The glyph mutes and restores;
 * the slider is draggable, tappable and keyboard-accessible.
 */
export function VolumeControl({ value, onChange }: VolumeControlProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<number | null>(null);
  const restore = useRef(value > 0.02 ? value : 0.7);

  const set = useCallback(
    (v: number) => {
      const next = clamp01(v);
      if (next > 0.02) restore.current = next;
      onChange(next);
    },
    [onChange],
  );

  const fromPointer = (event: PointerEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect) set((event.clientX - rect.left) / rect.width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    fromPointer(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragId.current === event.pointerId) fromPointer(event);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragId.current === event.pointerId) dragId.current = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.05;
    const keys: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      Home: 0,
      End: 1,
    };
    if (event.key in keys) {
      event.preventDefault();
      set(keys[event.key]);
    }
  };

  const muted = value <= 0.001;
  const toggleMute = () => (muted ? onChange(restore.current) : onChange(0));

  return (
    <div className="volume">
      <button type="button" className="volume__glyph" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <g className="volume__wave" style={{ opacity: muted ? 1 : 0 }}>{glyph(VOLUME_OFF)}</g>
          <g className="volume__wave" style={{ opacity: !muted && value <= 0.5 ? 1 : 0 }}>{glyph(VOLUME_DOWN)}</g>
          <g className="volume__wave" style={{ opacity: value > 0.5 ? 1 : 0 }}>{glyph(VOLUME_UP)}</g>
        </svg>
      </button>
      <div
        ref={trackRef}
        className="volume__track"
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className="volume__rail">
          <span className="volume__fill" style={{ transform: `scaleX(${value})` }} />
        </span>
        <span className="volume__knob" style={{ left: `${value * 100}%` }} />
      </div>
    </div>
  );
}
