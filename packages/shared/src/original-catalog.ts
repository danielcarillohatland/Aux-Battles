import type { Track } from './schemas.js';

export type AuxWaveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** Data-only recipe interpreted by the host's Web Audio synthesizer. */
export interface AuxSynthRecipe {
  bpm: number;
  rootHz: number;
  scale: readonly number[];
  bass: readonly number[];
  lead: readonly number[];
  chords: readonly number[];
  leadWave: AuxWaveform;
}

export interface AuxOriginalDefinition extends Track {
  source: 'original';
  durationMs: number;
  description: string;
  attribution: string;
  tags: readonly string[];
  synth: AuxSynthRecipe;
}

const ARTIST = 'AUX House Band';
const ALBUM = 'AUX Originals · Volume One';
const CREDIT = 'Original composition and real-time synthesis by AUX Battles; no samples used.';

/**
 * Publisher-owned source catalog. These are short, code-defined instrumental
 * pieces—not covers, sound-alikes, sampled recordings, or streaming embeds.
 */
export const AUX_ORIGINAL_TRACKS: readonly AuxOriginalDefinition[] = [
  {
    id: 'original:midnight-pancakes',
    title: 'Midnight Pancakes',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description: 'Playful funk-pop with a rubbery bassline, bright keys, and late-night mischief.',
    attribution: CREDIT,
    tags: ['funny', 'food', 'party', 'funk', 'playful', 'late night', 'chaos'],
    synth: {
      bpm: 112,
      rootHz: 110,
      scale: [0, 2, 4, 7, 9, 12],
      bass: [0, -1, 0, 2, -1, 3, 2, -1, 0, -1, 4, 3, -1, 2, 1, -1],
      lead: [4, -1, 5, 4, 2, -1, 3, 2, 5, -1, 4, 3, 2, 1, 2, -1],
      chords: [0, 3, 4, 2],
      leadWave: 'triangle',
    },
  },
  {
    id: 'original:confetti-forecast',
    title: 'Confetti Forecast',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description: 'Bright house-pop momentum built for victories, entrances, and optimistic chaos.',
    attribution: CREDIT,
    tags: ['victory', 'celebration', 'party', 'happy', 'dance', 'entrance'],
    synth: {
      bpm: 124,
      rootHz: 130.81,
      scale: [0, 2, 4, 7, 9, 11, 12],
      bass: [0, -1, 0, -1, 4, -1, 3, -1, 0, -1, 5, -1, 4, 3, 2, -1],
      lead: [0, 2, 4, 5, 4, 2, 6, 5, 4, 2, 3, 4, 5, 6, 4, -1],
      chords: [0, 4, 5, 3],
      leadWave: 'sawtooth',
    },
  },
  {
    id: 'original:pocket-sized-thunder',
    title: 'Pocket-Sized Thunder',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description:
      'Compact stomping electro-rock with swagger, sharp drums, and heroic overconfidence.',
    attribution: CREDIT,
    tags: ['hero', 'gym', 'power', 'swagger', 'rock', 'battle', 'dramatic'],
    synth: {
      bpm: 118,
      rootHz: 98,
      scale: [0, 3, 5, 7, 10, 12],
      bass: [0, 0, -1, 3, 0, -1, 4, 3, 0, 0, -1, 5, 4, 3, 2, -1],
      lead: [5, -1, 3, 4, 5, -1, 2, 3, 4, 5, 3, -1, 2, 4, 5, -1],
      chords: [0, 3, 4, 2],
      leadWave: 'square',
    },
  },
  {
    id: 'original:sunday-fast-forward',
    title: 'Sunday in Fast Forward',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description:
      'Warm indie-pop that starts relaxed and keeps tripping into cheerful forward motion.',
    attribution: CREDIT,
    tags: ['road trip', 'sunny', 'indie', 'warm', 'friends', 'montage'],
    synth: {
      bpm: 106,
      rootHz: 146.83,
      scale: [0, 2, 4, 7, 9, 12],
      bass: [0, -1, 3, -1, 4, -1, 2, -1, 0, -1, 4, -1, 3, 2, 1, -1],
      lead: [0, 1, 2, 4, 3, 2, 1, -1, 2, 3, 5, 4, 3, 2, 1, -1],
      chords: [0, 3, 4, 2],
      leadWave: 'sine',
    },
  },
  {
    id: 'original:last-bus-dancing',
    title: 'Last Bus Dancing',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description:
      'Bittersweet disco with tired feet, glowing windows, and one final burst of energy.',
    attribution: CREDIT,
    tags: ['disco', 'night', 'bittersweet', 'dance', 'goodbye', 'city'],
    synth: {
      bpm: 116,
      rootHz: 123.47,
      scale: [0, 3, 5, 7, 10, 12],
      bass: [0, -1, 0, 3, -1, 4, 3, -1, 0, -1, 5, 4, -1, 3, 2, -1],
      lead: [2, 3, 4, -1, 5, 4, 3, 2, 4, 5, 4, -1, 3, 2, 1, -1],
      chords: [0, 4, 3, 2],
      leadWave: 'triangle',
    },
  },
  {
    id: 'original:rain-check-rodeo',
    title: 'Rain Check Rodeo',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description:
      'Bouncy electronic country mischief with a loping bass and cartoon-sized confidence.',
    attribution: CREDIT,
    tags: ['country', 'comedy', 'rain', 'road', 'cowboy', 'mischief'],
    synth: {
      bpm: 108,
      rootHz: 110,
      scale: [0, 2, 4, 7, 9, 12],
      bass: [0, -1, 3, 0, -1, 4, 3, -1, 0, 2, -1, 4, 3, -1, 2, -1],
      lead: [0, 2, 4, 2, 5, -1, 4, 2, 0, 2, 3, 4, 5, 4, 2, -1],
      chords: [0, 3, 4, 0],
      leadWave: 'square',
    },
  },
  {
    id: 'original:wrong-turn-right-party',
    title: 'Wrong Turn, Right Party',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description: 'Restless dance-pop for accidents that become stories everyone keeps retelling.',
    attribution: CREDIT,
    tags: ['chaos', 'party', 'travel', 'accident', 'dance', 'adventure'],
    synth: {
      bpm: 126,
      rootHz: 116.54,
      scale: [0, 2, 3, 7, 9, 12],
      bass: [0, -1, 3, -1, 0, 4, -1, 3, 0, -1, 5, 4, 3, -1, 2, -1],
      lead: [5, 3, 4, 2, 3, 5, 4, -1, 2, 4, 5, 3, 4, 2, 1, -1],
      chords: [0, 3, 4, 2],
      leadWave: 'sawtooth',
    },
  },
  {
    id: 'original:soft-launch-heartbreak',
    title: 'Soft-Launch Heartbreak',
    artist: ARTIST,
    album: ALBUM,
    durationMs: 32_000,
    source: 'original',
    description:
      'Tender synth-pop with restrained drums, awkward hope, and a quietly dramatic lift.',
    attribution: CREDIT,
    tags: ['heartbreak', 'romance', 'sad', 'hopeful', 'dramatic', 'slow'],
    synth: {
      bpm: 92,
      rootHz: 103.83,
      scale: [0, 3, 5, 7, 10, 12],
      bass: [0, -1, -1, 3, -1, -1, 4, -1, 0, -1, -1, 5, -1, 4, 3, -1],
      lead: [2, -1, 3, 4, -1, 3, 2, -1, 4, -1, 5, 4, 3, -1, 2, -1],
      chords: [0, 3, 4, 2],
      leadWave: 'sine',
    },
  },
];

export function auxOriginalById(id: string): AuxOriginalDefinition | null {
  return AUX_ORIGINAL_TRACKS.find((track) => track.id === id) ?? null;
}
