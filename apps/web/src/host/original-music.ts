import { auxOriginalById, type AuxSynthRecipe, type AuxWaveform } from '@aux/shared';

export interface OriginalExcerptController {
  stop(): void;
}

type AudioContextWithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as AudioContextWithWebkit).webkitAudioContext;
}

function frequency(root: number, scale: readonly number[], degree: number, octave = 0): number {
  const normalized = Math.max(0, degree);
  const scaleIndex = normalized % scale.length;
  const scaleOctave = Math.floor(normalized / scale.length);
  return root * 2 ** (((scale[scaleIndex] ?? 0) + (scaleOctave + octave) * 12) / 12);
}

/** Pure helper retained for tests and visualizers. */
export function originalStepDurationMs(trackId: string): number | null {
  const track = auxOriginalById(trackId);
  return track === null ? null : 60_000 / track.synth.bpm / 4;
}

export async function playOriginalExcerpt(
  trackId: string,
  startMs: number,
  durationMs: number,
  onEnded: () => void,
): Promise<OriginalExcerptController> {
  const definition = auxOriginalById(trackId);
  if (definition === null) throw new Error('AUX original recipe not found');
  const AudioContextClass = audioContextConstructor();
  if (AudioContextClass === undefined) throw new Error('Web Audio is unavailable on this device');

  const context = new AudioContextClass();
  await context.resume();
  const master = context.createGain();
  const compressor = context.createDynamicsCompressor();
  master.gain.value = 0.34;
  compressor.threshold.value = -20;
  compressor.knee.value = 18;
  compressor.ratio.value = 5;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.22;
  master.connect(compressor);
  compressor.connect(context.destination);

  const noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.06), context.sampleRate);
  const noiseSamples = noise.getChannelData(0);
  for (let index = 0; index < noiseSamples.length; index += 1) {
    noiseSamples[index] = Math.random() * 2 - 1;
  }

  const active = new Set<AudioScheduledSourceNode>();
  const remember = <T extends AudioScheduledSourceNode>(node: T): T => {
    active.add(node);
    node.addEventListener('ended', () => active.delete(node), { once: true });
    return node;
  };

  const tone = (
    recipe: AuxSynthRecipe,
    value: number,
    startsAt: number,
    length: number,
    level: number,
    wave: AuxWaveform,
    octave = 0,
  ) => {
    if (value < 0) return;
    const oscillator = remember(context.createOscillator());
    const envelope = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(
      frequency(recipe.rootHz, recipe.scale, value, octave),
      startsAt,
    );
    envelope.gain.setValueAtTime(0.0001, startsAt);
    envelope.gain.exponentialRampToValueAtTime(level, startsAt + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + length);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + length + 0.02);
  };

  const kick = (startsAt: number) => {
    const oscillator = remember(context.createOscillator());
    const envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(128, startsAt);
    oscillator.frequency.exponentialRampToValueAtTime(43, startsAt + 0.13);
    envelope.gain.setValueAtTime(0.18, startsAt);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.17);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.18);
  };

  const hat = (startsAt: number, level: number) => {
    const source = remember(context.createBufferSource());
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = noise;
    filter.type = 'highpass';
    filter.frequency.value = 5_800;
    envelope.gain.setValueAtTime(level, startsAt);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.045);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    source.start(startsAt);
    source.stop(startsAt + 0.05);
  };

  const recipe = definition.synth;
  const stepSeconds = 60 / recipe.bpm / 4;
  let absoluteStep = Math.floor(Math.max(0, startMs) / 1_000 / stepSeconds);
  let nextAt = context.currentTime + 0.04;
  const endAt = context.currentTime + Math.max(0.25, durationMs / 1_000);
  let stopped = false;

  const scheduleStep = (step: number, startsAt: number) => {
    const slot = step % 16;
    const bass = recipe.bass[slot] ?? -1;
    const lead = recipe.lead[slot] ?? -1;
    if (slot % 4 === 0) kick(startsAt);
    if (slot % 2 === 0) hat(startsAt, slot % 4 === 2 ? 0.035 : 0.02);
    tone(recipe, bass, startsAt, stepSeconds * 1.7, 0.075, 'triangle', -1);
    tone(recipe, lead, startsAt, stepSeconds * 0.82, 0.032, recipe.leadWave, 1);
    if (slot % 4 === 0) {
      const chord = recipe.chords[Math.floor(slot / 4) % recipe.chords.length] ?? 0;
      tone(recipe, chord, startsAt, stepSeconds * 3.5, 0.018, 'sine');
      tone(recipe, chord + 2, startsAt, stepSeconds * 3.5, 0.014, 'sine');
      tone(recipe, chord + 4, startsAt, stepSeconds * 3.5, 0.012, 'sine');
    }
  };

  const schedule = () => {
    const horizon = Math.min(endAt, context.currentTime + 0.16);
    while (!stopped && nextAt < horizon) {
      scheduleStep(absoluteStep, nextAt);
      absoluteStep += 1;
      nextAt += stepSeconds;
    }
  };
  schedule();
  const scheduler = setInterval(schedule, 40);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(scheduler);
    clearTimeout(finisher);
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    for (const node of active) {
      try {
        node.stop(now + 0.06);
      } catch {
        // A node that ended between iteration and stop is already harmless.
      }
    }
    setTimeout(() => void context.close(), 80);
  };
  const finisher = setTimeout(
    () => {
      if (stopped) return;
      stop();
      onEnded();
    },
    Math.max(250, durationMs),
  );

  return { stop };
}
