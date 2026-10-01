import { useEffect, useRef, useState } from 'react';
import { Instrument } from './instrument/Instrument';
import { MUSIC_NOTE, MUSIC_OFF, PIANO, PIANO_OFF } from './ui/icons';
import { ToggleButton } from './ui/ToggleButton';
import { VolumeControl } from './ui/VolumeControl';

const VOLUME_KEY = 'sea.volume';
const MUSIC_MODE_KEY = 'sea.musicMode';
const GRID_KEY = 'sea.grid';
const DEFAULT_VOLUME = 0.72;

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the setting simply isn't remembered */
  }
}

function loadVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return stored > 0 && stored <= 1 ? stored : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const instrumentRef = useRef<Instrument | null>(null);
  const [volume, setVolume] = useState(loadVolume);
  const [musicMode, setMusicMode] = useState(false);
  // Music Mode is remembered, but audio may only start after a gesture: a remembered
  // "on" is restored silently and the drone begins with the first touch.
  const restoreMusicMode = useRef(loadFlag(MUSIC_MODE_KEY));
  const [grid, setGrid] = useState(() => loadFlag(GRID_KEY));

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const instrument = new Instrument(surface);
    instrumentRef.current = instrument;
    instrument.setGrid(loadFlag(GRID_KEY));
    if (restoreMusicMode.current) {
      instrument.setMusicMode(true, false);
      setMusicMode(true);
    }
    return () => {
      instrument.dispose();
      instrumentRef.current = null;
    };
  }, []);

  useEffect(() => {
    instrumentRef.current?.setVolume(volume);
    // Remember the level once a drag settles (a muted instrument should not reopen muted).
    if (volume <= 0) return;
    const timer = window.setTimeout(() => store(VOLUME_KEY, String(volume)), 300);
    return () => window.clearTimeout(timer);
  }, [volume]);

  const toggleMusicMode = () => {
    const next = !musicMode;
    setMusicMode(next);
    instrumentRef.current?.setMusicMode(next, true);
    store(MUSIC_MODE_KEY, next ? '1' : '0');
  };

  const toggleGrid = () => {
    const next = !grid;
    setGrid(next);
    instrumentRef.current?.setGrid(next);
    store(GRID_KEY, next ? '1' : '0');
  };

  return (
    <main className="sea">
      <div ref={surfaceRef} className="surface" />
      <div className="controls">
        <ToggleButton label="Note grid" active={grid} onToggle={toggleGrid} icon={PIANO} offIcon={PIANO_OFF} />
        <ToggleButton
          label="Music mode"
          active={musicMode}
          onToggle={toggleMusicMode}
          icon={MUSIC_NOTE}
          offIcon={MUSIC_OFF}
        />
        <VolumeControl value={volume} onChange={setVolume} />
      </div>
    </main>
  );
}
