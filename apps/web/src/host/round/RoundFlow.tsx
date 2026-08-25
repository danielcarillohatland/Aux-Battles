/**
 * AUX BATTLES — host round flow (Phase 3): one Switch over the FSM state,
 * mounting the right step screen. Pure routing — every mutation is delegated
 * upward (REST per D-D); the snapshot remains the single source of truth.
 *
 *   CATEGORY        → CategoryPicker   (presets + free-text → PICK_CATEGORY)
 *   SCENARIO        → ScenarioDisplay  (big scenario + phaseEndsAt countdown ring)
 *   SONG_SELECTION  → SelectionProgress(N/M submitted, live from WS frames)
 *   LOCKED          → LockedStaging    (Begin Playback → BEGIN_PLAYBACK)
 *   PLAYBACK        → PlaybackView     (api: now-playing · manual: ManualPlayback)
 *
 * LOBBY and the post-playback states keep rendering in HostLobby.
 */
import { Match, Switch } from 'solid-js';
import type { Snapshot, Track } from '@aux/shared';
import { CategoryPicker } from './CategoryPicker.js';
import { ScenarioDisplay } from './ScenarioDisplay.js';
import { SelectionProgress } from './SelectionProgress.js';
import { LockedStaging } from './LockedStaging.js';
import { PlaybackView } from './PlaybackView.js';

export interface RoundFlowProps {
  snapshot: Snapshot;
  countdownSeconds: number | null;
  /** The category/scenario for this round (host-local until snapshots carry it). */
  scenario: string;
  busy: boolean;
  /** Round queue mirror for PLAYBACK. */
  queue: Track[];
  playbackIndex: number;
  onPickCategory: (category: string) => void;
  onBeginPlayback: () => void;
  onManualAdvance: () => void;
}

export const RoundFlow = (props: RoundFlowProps) => (
  <Switch>
    <Match when={props.snapshot.state === 'CATEGORY'}>
      <CategoryPicker busy={props.busy} onPick={props.onPickCategory} />
    </Match>
    <Match when={props.snapshot.state === 'SCENARIO'}>
      <ScenarioDisplay scenario={props.scenario} countdownSeconds={props.countdownSeconds} />
    </Match>
    <Match when={props.snapshot.state === 'SONG_SELECTION'}>
      <SelectionProgress
        submittedCount={props.snapshot.submissionsCount}
        totalPlayers={props.snapshot.players.length}
        countdownSeconds={props.countdownSeconds}
      />
    </Match>
    <Match when={props.snapshot.state === 'LOCKED'}>
      <LockedStaging
        submittedCount={props.snapshot.submissionsCount}
        busy={props.busy}
        onBegin={props.onBeginPlayback}
      />
    </Match>
    <Match when={props.snapshot.state === 'PLAYBACK'}>
      <PlaybackView
        mode={props.snapshot.playbackMode}
        queue={props.queue}
        currentIndex={props.playbackIndex}
        onManualAdvance={props.onManualAdvance}
      />
    </Match>
  </Switch>
);
