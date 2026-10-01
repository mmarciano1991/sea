import { useId } from 'react';
import { glyph } from './icons';

interface ToggleButtonProps {
  label: string;
  active: boolean;
  onToggle(): void;
  /** Material Symbols path data for the "on" glyph. */
  icon: string;
  /** Material Symbols path data for the matching "off" glyph. */
  offIcon: string;
}

/**
 * A quiet on/off control in the language of the volume glyph.
 * Active: a small solid disc with the icon cut out of it.
 * Inactive: the icon's "off" variant. The two states cross-fade.
 */
export function ToggleButton({ label, active, onToggle, icon, offIcon }: ToggleButtonProps) {
  const id = useId();
  const cutout = `${id}-cutout`;
  return (
    <button
      type="button"
      className={`toggle${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <defs>
          <mask id={cutout} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="white" />
            <g fill="black">{glyph(icon, 0.68)}</g>
          </mask>
        </defs>
        <circle className="toggle__disc" cx="12" cy="12" r="11" mask={`url(#${cutout})`} />
        <g className="toggle__off">{glyph(offIcon)}</g>
      </svg>
    </button>
  );
}
