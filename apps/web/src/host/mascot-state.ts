/**
 * DJ AUX reactions (D-034). Pure so it is unit-testable in node; the component
 * turns a mood into motion and a talk key into a mouth animation.
 */
import type { Snapshot } from '@aux/shared';

export type MascotMood =
  'idle' | 'welcome' | 'search' | 'listen' | 'think' | 'praise' | 'roast' | 'reveal' | 'celebrate';

/** Changes whenever DJ AUX should visibly deliver a line (mouth animation). */
export function mascotTalkKey(snapshot: Snapshot | null | undefined): string | null {
  if (snapshot === undefined || snapshot === null) return null;
  if (snapshot.state === 'AI_JUDGING' && snapshot.judgingStatus === 'revealed') {
    return `judge:${snapshot.roundIdx}:${snapshot.judgingIndex ?? 0}`;
  }
  if (snapshot.state === 'RESULTS' && (snapshot.results?.length ?? 0) > 0) {
    return `reveal:${snapshot.roundIdx}:${snapshot.results!.length}`;
  }
  return null;
}

/** What DJ AUX is doing right now, derived from the room snapshot. */
export function mascotMood(snapshot: Snapshot | null | undefined): MascotMood {
  if (snapshot === undefined || snapshot === null) return 'welcome';
  switch (snapshot.state) {
    case 'LOBBY':
      return 'welcome';
    case 'CATEGORY':
    case 'SCENARIO':
    case 'SONG_SELECTION':
      return 'search';
    case 'LOCKED':
      return 'idle';
    case 'PLAYBACK':
      return 'listen';
    case 'AI_JUDGING': {
      if (snapshot.judgingStatus !== 'revealed') return 'think';
      const score = snapshot.judgingResult?.totalScore;
      if (score === undefined) return 'think';
      return score < 4 ? 'roast' : score >= 8 ? 'praise' : 'idle';
    }
    case 'RESULTS':
      return 'reveal';
    case 'LEADERBOARD':
      return 'praise';
    case 'GAME_OVER':
      return 'celebrate';
  }
}

/** One short line under the mascot for each mood. */
export function mascotLine(
  mood: MascotMood,
  ctx: { players?: number; submissions?: number },
): string {
  switch (mood) {
    case 'welcome':
      return (ctx.players ?? 0) === 0
        ? 'Waiting for the first challenger'
        : `${ctx.players} on the floor`;
    case 'search':
      return `${ctx.submissions ?? 0}/${ctx.players ?? 0} picks in`;
    case 'idle':
      return 'No take-backs';
    case 'listen':
      return 'Volume up';
    case 'think':
      return 'Judging…';
    case 'praise':
      return 'Okay. Okay okay okay.';
    case 'roast':
      return 'Bold. Wrong. Bold and wrong.';
    case 'reveal':
      return 'And the points go to…';
    case 'celebrate':
      return 'Legendary set';
  }
}
