import type { FsmState } from '@aux/shared';

export type GameMusicScene = 'silent' | 'lobby' | 'gameplay';

/** Submitted tracks need the speakers to themselves. */
export function musicSceneForState(state: FsmState): GameMusicScene {
  if (state === 'PLAYBACK') return 'silent';
  return state === 'LOBBY' ? 'lobby' : 'gameplay';
}

// ── Engine ───────────────────────────────────────────────────────────────────
// Everything is synthesized: no audio assets, no licensing. Voices feed four
// buses so pads stay soft, bass stays round, and only the lead gets an echo.

interface Buses {
  pad: GainNode;
  padFilter: BiquadFilterNode;
  bass: GainNode;
  bassFilter: BiquadFilterNode;
  lead: GainNode;
  echo: DelayNode;
  drums: GainNode;
}

let context: AudioContext | undefined;
let master: GainNode | undefined;
let buses: Buses | undefined;
let noiseBuffer: AudioBuffer | undefined;
let transport: ReturnType<typeof setInterval> | undefined;
let scene: GameMusicScene = 'silent';
let enabled = false;
let step = 0;
let nextNoteAt = 0;

const STEPS_PER_BAR = 16;
const TEMPO: Record<Exclude<GameMusicScene, 'silent'>, number> = { lobby: 90, gameplay: 112 };

const contextConstructor = (): typeof AudioContext | undefined => {
  if (typeof window === 'undefined') return undefined;
  const withWebkit = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? withWebkit.webkitAudioContext;
};

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

function ensureAudio(): boolean {
  if (context !== undefined && master !== undefined && buses !== undefined) return true;
  const AudioContextClass = contextConstructor();
  if (AudioContextClass === undefined) return false;

  const ac = new AudioContextClass();
  context = ac;
  const compressor = ac.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 20;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.012;
  compressor.release.value = 0.25;

  master = ac.createGain();
  master.gain.value = 0.0001;
  master.connect(compressor);
  compressor.connect(ac.destination);

  const pad = ac.createGain();
  const padFilter = ac.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 1_400;
  padFilter.Q.value = 0.6;
  pad.connect(padFilter).connect(master);

  const bass = ac.createGain();
  const bassFilter = ac.createBiquadFilter();
  bassFilter.type = 'lowpass';
  bassFilter.frequency.value = 650;
  bassFilter.Q.value = 1.4;
  bass.connect(bassFilter).connect(master);

  // Lead: dry signal plus a darkened dotted-eighth echo.
  const lead = ac.createGain();
  lead.connect(master);
  const echo = ac.createDelay(1.5);
  const feedback = ac.createGain();
  feedback.gain.value = 0.32;
  const echoTone = ac.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 2_200;
  const wet = ac.createGain();
  wet.gain.value = 0.3;
  lead.connect(echo);
  echo.connect(echoTone).connect(feedback).connect(echo);
  echoTone.connect(wet).connect(master);

  const drums = ac.createGain();
  drums.connect(master);

  buses = { pad, padFilter, bass, bassFilter, lead, echo, drums };

  noiseBuffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate);
  const samples = noiseBuffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
  return true;
}

function fadeMaster(target: number): void {
  if (context === undefined || master === undefined) return;
  const now = context.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + 0.6);
}

/** Smoothly move a filter cutoff so changes never click. */
function glideFilter(filter: BiquadFilterNode, frequency: number, at: number, over: number): void {
  filter.frequency.cancelScheduledValues(at);
  filter.frequency.setValueAtTime(filter.frequency.value, at);
  filter.frequency.linearRampToValueAtTime(frequency, at + over);
}

interface VoiceOptions {
  wave?: OscillatorType;
  attack?: number;
  /** Detune in cents for a second, slightly sharp oscillator (chorus width). */
  spread?: number;
  /** Per-note lowpass sweep: starts open, closes to `filterEnd`. */
  filterStart?: number;
  filterEnd?: number;
}

function voice(
  bus: AudioNode,
  frequency: number,
  startsAt: number,
  duration: number,
  volume: number,
  options: VoiceOptions = {},
): void {
  if (context === undefined) return;
  const { wave = 'triangle', spread = 0 } = options;
  // Envelope points must stay ordered even for very short notes.
  const attack = Math.min(options.attack ?? 0.012, duration * 0.5);
  const sustainUntil = Math.min(duration * 0.9, Math.max(attack, duration * 0.35));
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, startsAt);
  envelope.gain.exponentialRampToValueAtTime(volume, startsAt + attack);
  envelope.gain.setValueAtTime(volume, startsAt + sustainUntil);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  let output: AudioNode = envelope;
  if (options.filterStart !== undefined) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(options.filterStart, startsAt);
    filter.frequency.exponentialRampToValueAtTime(
      options.filterEnd ?? options.filterStart / 4,
      startsAt + duration,
    );
    envelope.connect(filter);
    output = filter;
  }
  output.connect(bus);

  for (const cents of spread === 0 ? [0] : [-spread, spread]) {
    const oscillator = context.createOscillator();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    oscillator.detune.setValueAtTime(cents, startsAt);
    oscillator.connect(envelope);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.03);
  }
}

function kick(startsAt: number, volume: number, punch = 1): void {
  if (context === undefined || buses === undefined) return;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(120 + 40 * punch, startsAt);
  oscillator.frequency.exponentialRampToValueAtTime(42, startsAt + 0.11);
  envelope.gain.setValueAtTime(volume, startsAt);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.22);
  oscillator.connect(envelope).connect(buses.drums);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + 0.24);
}

function noise(
  startsAt: number,
  duration: number,
  volume: number,
  filterType: BiquadFilterType,
  frequency: number,
  q = 0.8,
): void {
  if (context === undefined || buses === undefined || noiseBuffer === undefined) return;
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const envelope = context.createGain();
  source.buffer = noiseBuffer;
  filter.type = filterType;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  envelope.gain.setValueAtTime(volume, startsAt);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  source.connect(filter).connect(envelope).connect(buses.drums);
  // Random offset so repeated hits never sound identical.
  source.start(startsAt, Math.random() * 0.3);
  source.stop(startsAt + duration + 0.02);
}

const hat = (at: number, volume: number, open = false) =>
  noise(at, open ? 0.16 : 0.035, volume, 'highpass', open ? 7_000 : 8_500);

function snare(startsAt: number, volume: number): void {
  noise(startsAt, 0.16, volume, 'bandpass', 1_900, 0.9);
  if (buses !== undefined) voice(buses.drums, 185, startsAt, 0.09, volume * 0.55, { wave: 'sine' });
}

function clap(startsAt: number, volume: number): void {
  // Three tight bursts read as hands, not a drum.
  for (const offset of [0, 0.011, 0.023]) noise(startsAt + offset, 0.05, volume, 'bandpass', 1_300);
  noise(startsAt + 0.03, 0.18, volume * 0.6, 'bandpass', 1_300);
}

// ── Lobby: unhurried lo-fi, 8-bar progression with an A/B melody ────────────

/** Fmaj7 – Em7 – Dm7 – Cmaj7 | Am7 – Dm9 – Gsus – G7 */
const LOBBY_BARS = [
  { root: 41, chord: [53, 57, 60, 64] },
  { root: 40, chord: [52, 55, 59, 62] },
  { root: 38, chord: [50, 53, 57, 60] },
  { root: 36, chord: [48, 52, 55, 59] },
  { root: 45, chord: [52, 55, 57, 60] },
  { root: 38, chord: [53, 57, 60, 64] },
  { root: 43, chord: [53, 55, 60, 62] },
  { root: 43, chord: [53, 55, 59, 62] },
] as const;

// C-major pentatonic phrases, one per bar (null = rest). Section B answers A.
const _ = null;
const LOBBY_MELODY: ReadonlyArray<ReadonlyArray<number | null>> = [
  [_, _, _, _, 76, _, _, 79, _, _, 81, _, 79, _, _, _],
  [_, _, 76, _, _, _, 74, _, 72, _, _, _, _, _, _, _],
  [_, _, _, _, 74, _, 76, _, _, 79, _, _, 76, _, 74, _],
  [72, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  [_, _, 81, _, 79, _, _, 76, _, _, _, _, 79, _, 81, _],
  [84, _, _, _, 81, _, _, _, 79, _, 76, _, _, _, _, _],
  [_, _, _, _, 74, _, 76, _, 79, _, _, _, 74, _, _, _],
  [_, _, 76, _, _, _, 74, _, _, _, 72, _, _, _, _, _],
];

function scheduleLobby(currentStep: number, at: number, stepSeconds: number): void {
  if (buses === undefined) return;
  const beat = currentStep % STEPS_PER_BAR;
  const barIndex = Math.floor(currentStep / STEPS_PER_BAR);
  const bar = LOBBY_BARS[barIndex % LOBBY_BARS.length]!;
  const barSeconds = stepSeconds * STEPS_PER_BAR;
  // Lazy swing: every second sixteenth lands late.
  const swung = beat % 2 === 1 ? at + stepSeconds * 0.28 : at;

  if (beat === 0) {
    // Soft, chorused pad that breathes in instead of striking.
    for (const note of bar.chord) {
      voice(buses.pad, hz(note), at, barSeconds * 1.05, 0.016, {
        wave: 'triangle',
        attack: 0.35,
        spread: 7,
      });
    }
    // The pad filter slowly opens across section B, then settles.
    const open = barIndex % 8 >= 4 ? 1_900 : 1_300;
    glideFilter(buses.padFilter, open, at, barSeconds);
  }

  // Round, low-passed bass that walks to the fifth and back.
  if (beat === 0) voice(buses.bass, hz(bar.root), at, stepSeconds * 5, 0.07, { wave: 'triangle' });
  if (beat === 6) voice(buses.bass, hz(bar.root), at, stepSeconds * 3, 0.045, { wave: 'triangle' });
  if (beat === 10) {
    voice(buses.bass, hz(bar.root + 7), at, stepSeconds * 4, 0.05, { wave: 'triangle' });
  }
  if (beat === 14 && barIndex % 2 === 1) {
    voice(buses.bass, hz(bar.root + 12), at, stepSeconds * 2, 0.035, { wave: 'triangle' });
  }

  // Laid-back drums: kick on 1 and the "and" of 3, rim-soft snare on 2 and 4.
  if (beat === 0) kick(at, 0.11, 0.6);
  if (beat === 10) kick(at, 0.075, 0.4);
  if (beat === 4 || beat === 12) snare(at, 0.032);
  if (beat % 2 === 0 || beat === 15) hat(swung, beat % 4 === 2 ? 0.016 : 0.009);
  if (beat === 14 && barIndex % 4 === 3) hat(swung, 0.014, true);

  // Bell melody: sine plus a quiet octave, into the echo bus.
  const note = LOBBY_MELODY[barIndex % LOBBY_MELODY.length]![beat];
  if (note !== null && note !== undefined) {
    voice(buses.lead, hz(note), swung, stepSeconds * 3, 0.022, { wave: 'sine', attack: 0.006 });
    voice(buses.lead, hz(note + 12), swung, stepSeconds * 1.5, 0.006, { wave: 'sine' });
  }
}

// ── Gameplay: minor-key drive that builds over 8 bars ────────────────────────

/** Am7 – Fmaj7 – Dm7 – E7 | Am7 – Fmaj7 – G – E7 */
const GAME_BARS = [
  { root: 45, chord: [57, 60, 64, 67] },
  { root: 41, chord: [57, 60, 64, 65] },
  { root: 38, chord: [57, 60, 62, 65] },
  { root: 40, chord: [56, 59, 62, 64] },
  { root: 45, chord: [57, 60, 64, 67] },
  { root: 41, chord: [57, 60, 64, 65] },
  { root: 43, chord: [55, 59, 62, 67] },
  { root: 40, chord: [56, 59, 62, 64] },
] as const;

const ARP_UP = [0, 1, 2, 3, 2, 1, 2, 3] as const;
const ARP_DOWN = [3, 2, 1, 0, 1, 2, 1, 0] as const;

function scheduleGameplay(currentStep: number, at: number, stepSeconds: number): void {
  if (buses === undefined) return;
  const beat = currentStep % STEPS_PER_BAR;
  const barIndex = Math.floor(currentStep / STEPS_PER_BAR);
  const cycleBar = barIndex % GAME_BARS.length;
  const bar = GAME_BARS[cycleBar]!;
  const barSeconds = stepSeconds * STEPS_PER_BAR;
  const fillBar = cycleBar === 7;

  if (beat === 0) {
    for (const note of bar.chord) {
      voice(buses.pad, hz(note - 12), at, barSeconds, 0.009, {
        wave: 'sawtooth',
        attack: 0.2,
        spread: 9,
      });
    }
    // Tension builds: the bass filter opens through the cycle, then resets.
    glideFilter(buses.bassFilter, 480 + cycleBar * 85, at, barSeconds);
  }

  // Pulsing eighth-note bass with an octave bounce and a per-note filter pluck.
  if (beat % 2 === 0) {
    const octave = beat % 8 === 6 ? 12 : 0;
    voice(buses.bass, hz(bar.root + octave), at, stepSeconds * 1.7, beat % 4 === 0 ? 0.06 : 0.042, {
      wave: 'sawtooth',
      filterStart: 1_600,
      filterEnd: 260,
    });
  }

  // Sixteenth arpeggio: rests for the first two bars, flips direction in B.
  if (cycleBar >= 2) {
    const pattern = cycleBar >= 4 ? ARP_DOWN : ARP_UP;
    const tone = bar.chord[pattern[beat % pattern.length]!]! + 12;
    const accent = beat % 4 === 0 ? 1.4 : 1;
    voice(buses.lead, hz(tone), at, stepSeconds * 0.9, 0.0085 * accent, {
      wave: 'square',
      filterStart: 2_400 + cycleBar * 220,
      filterEnd: 700,
    });
  }

  // Four on the floor, claps on 2 and 4, open hats on the off-beats.
  if (beat % 4 === 0 && !(fillBar && beat === 12)) kick(at, beat === 0 ? 0.13 : 0.1);
  if ((beat === 4 || beat === 12) && !(fillBar && beat === 12)) clap(at, 0.03);
  if (beat % 4 === 2) hat(at, 0.02, true);
  else hat(at, beat % 2 === 0 ? 0.012 : 0.007);

  // Every eighth bar ends with a snare roll into the loop.
  if (fillBar && beat >= 12) snare(at, 0.02 + (beat - 12) * 0.008);
}

// ── Transport ────────────────────────────────────────────────────────────────

function schedule(): void {
  if (!enabled || context === undefined || context.state !== 'running' || scene === 'silent')
    return;
  const stepSeconds = 60 / TEMPO[scene] / 4;
  const horizon = context.currentTime + 0.16;
  while (nextNoteAt < horizon) {
    if (scene === 'lobby') scheduleLobby(step, nextNoteAt, stepSeconds);
    else scheduleGameplay(step, nextNoteAt, stepSeconds);
    step += 1;
    nextNoteAt += stepSeconds;
  }
}

function startTransport(): void {
  if (!enabled || context === undefined || context.state !== 'running') return;
  if (transport !== undefined) clearInterval(transport);
  transport = undefined;
  step = 0;
  nextNoteAt = context.currentTime + 0.05;
  // Levels sit just under the reveal effects and conversation (~-43 dBFS RMS).
  fadeMaster(scene === 'lobby' ? 0.17 : scene === 'gameplay' ? 0.2 : 0.0001);
  if (scene === 'silent') return;
  // Echo locks to a dotted eighth at the scene's tempo.
  if (buses !== undefined) {
    buses.echo.delayTime.setValueAtTime((60 / TEMPO[scene] / 4) * 3, context.currentTime);
  }
  schedule();
  transport = setInterval(schedule, 40);
}

/** Call directly inside a click handler so browser autoplay rules are satisfied. */
export function enableGameMusic(): boolean {
  enabled = true;
  if (!ensureAudio() || context === undefined) return false;
  if (context.state === 'running') startTransport();
  else
    void context
      .resume()
      .then(startTransport)
      .catch(() => {});
  return true;
}

export function disableGameMusic(): void {
  enabled = false;
  if (transport !== undefined) clearInterval(transport);
  transport = undefined;
  fadeMaster(0.0001);
}

export function isGameMusicEnabled(): boolean {
  return enabled;
}

export function setGameMusicScene(next: GameMusicScene): void {
  if (scene === next) return;
  scene = next;
  if (!enabled || context === undefined) return;
  startTransport();
}
