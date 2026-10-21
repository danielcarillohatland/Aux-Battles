/**
 * AUX BATTLES — host round flow (Phase 3): one Switch over the FSM state,
 * mounting the right step screen. Pure routing — every mutation is delegated
 * upward (REST per D-D); the snapshot remains the single source of truth.
 *
 *   CATEGORY        → CategoryPicker   (presets + free-text → PICK_CATEGORY)
 *   SCENARIO        → ScenarioDisplay  (big scenario + phaseEndsAt countdown ring)
 *   SONG_SELECTION  → SelectionProgress(N/M submitted, live from WS frames)
 *   LOCKED          → LockedStaging    (Begin Playback → BEGIN_PLAYBACK)
 *   PLAYBACK        → PlaybackView     (embedded video / audio · manual recovery)
 *   AI_JUDGING      → JudgingView · LEADERBOARD → LeaderboardView · GAME_OVER → GameOverView
 *
 * LOBBY and RESULTS (host/Reveal.tsx) render in HostLobby.
 */
import { Match, Show, Switch } from 'solid-js';
import { CrowdVote } from '../../player/CrowdVote.js';
import type { Snapshot, Track } from '@aux/shared';
import { CategoryPicker } from './CategoryPicker.js';
import { ScenarioDisplay } from './ScenarioDisplay.js';
import { SelectionProgress } from './SelectionProgress.js';
import { LockedStaging } from './LockedStaging.js';
import { PlaybackView } from './PlaybackView.js';
import { GameOverView, JudgingView, LeaderboardView } from './PostRound.js';

export interface RoundFlowProps {
  snapshot: Snapshot;
  /** Live picks count (count-only frames arrive between snapshots). */
  submissionsCount: number;
  countdownSeconds: number | null;
  /** The category/scenario for this round (host-local until snapshots carry it). */
  scenario: string;
  busy: boolean;
  /** Round queue mirror for PLAYBACK. */
  queue: Track[];
  playbackIndex: number;
  hostToken: string;
  onPickCategory: (category: string) => void;
  onBeginPlayback: () => void;
  onManualAdvance: () => void;
  onNextJudgement: () => void;
  onCloseVote: () => void;
  onAdvanceReveal: (final: boolean) => void;
  onNextRound: () => void;
  onFinish: () => void;
  onPlayAgain: () => void;
}

export const RoundFlow = (props: RoundFlowProps) => (
  <Switch>
    <Match when={props.snapshot.state === 'CATEGORY'}>
      <CategoryPicker busy={props.busy} onPick={props.onPickCategory} />
    </Match>
    <Match when={props.snapshot.state === 'SCENARIO'}>
      <ScenarioDisplay
        scenario={props.scenario}
        vibe={props.snapshot.scenarioVibe}
        category={props.snapshot.category}
        roundNumber={props.snapshot.roundIdx + 1}
        countdownSeconds={props.countdownSeconds}
      />
    </Match>
    <Match when={props.snapshot.state === 'SONG_SELECTION'}>
      <SelectionProgress
        scenario={props.scenario}
        vibe={props.snapshot.scenarioVibe}
        submittedCount={props.submissionsCount}
        totalPlayers={props.snapshot.players.length}
        countdownSeconds={props.countdownSeconds}
      />
    </Match>
    <Match when={props.snapshot.state === 'LOCKED'}>
      <LockedStaging
        submittedCount={props.submissionsCount}
        busy={props.busy}
        onBegin={props.onBeginPlayback}
      />
    </Match>
    <Match when={props.snapshot.state === 'PLAYBACK'}>
      <PlaybackView
        roomCode={props.snapshot.roomCode}
        mode={props.snapshot.playbackMode}
        queue={props.queue}
        currentIndex={props.playbackIndex}
        playbackStatus={props.snapshot.playbackStatus ?? 'ready'}
        playbackDevice={props.snapshot.playbackDevice ?? null}
        playbackError={props.snapshot.playbackError ?? null}
        excerptStartMs={props.snapshot.excerptStartMs ?? 0}
        excerptDurationMs={props.snapshot.excerptDurationMs ?? 30_000}
        excerptStartedAt={props.snapshot.excerptStartedAt ?? null}
        hostToken={props.hostToken}
        onAdvance={props.onManualAdvance}
      />
    </Match>
    <Match when={props.snapshot.state === 'AI_JUDGING'}>
      <Show
        when={props.snapshot.judgingMode === 'crowd'}
        fallback={
          <JudgingView snapshot={props.snapshot} busy={props.busy} onNext={props.onNextJudgement} />
        }
      >
        <CrowdVote snapshot={props.snapshot} busy={props.busy} onClose={props.onCloseVote} />
      </Show>
    </Match>
    <Match when={props.snapshot.state === 'LEADERBOARD'}>
      <LeaderboardView
        snapshot={props.snapshot}
        busy={props.busy}
        onNextRound={props.onNextRound}
        onFinish={props.onFinish}
      />
    </Match>
    <Match when={props.snapshot.state === 'GAME_OVER'}>
      <GameOverView snapshot={props.snapshot} busy={props.busy} onPlayAgain={props.onPlayAgain} />
    </Match>
  </Switch>
);
