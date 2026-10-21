import { Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';
import type { ConnState } from './ws.js';
import { DjAux } from './DjAux.js';
import { mascotLine, type MascotMood } from './mascot-state.js';

const PHASE_LABEL: Record<Snapshot['state'], string> = {
  LOBBY: 'Lobby',
  CATEGORY: 'Vibe',
  SCENARIO: 'Prompt',
  SONG_SELECTION: 'Picking',
  LOCKED: 'Locked',
  PLAYBACK: 'Listening',
  AI_JUDGING: 'Judging',
  RESULTS: 'Reveal',
  LEADERBOARD: 'Standings',
  GAME_OVER: 'Final',
};

interface StageHudProps {
  state: Snapshot['state'];
  roundNumber: number;
  playerCount: number;
  submissions: number;
  countdownSeconds: number | null;
  connection: ConnState;
  fullscreen: boolean;
  musicEnabled: boolean;
  mood: MascotMood;
  talkKey: string | null;
  onToggleFullscreen: () => void;
  onToggleMusic: () => void;
  /** Abandon this room (stale session, stuck game) and return to the landing page. */
  onNewRoom: () => void;
}

/** The show bar: mascot, round + phase, timer, and the host's tools. */
export const StageHud = (props: StageHudProps) => (
  <header class="showbar" data-connection={props.connection}>
    <DjAux
      mood={props.mood}
      talkKey={props.talkKey}
      line={mascotLine(props.mood, {
        players: props.playerCount,
        submissions: props.submissions,
      })}
    />
    <div class="showbar-phase">
      <strong class="showbar-title">
        <Show when={props.state !== 'LOBBY'} fallback="AUX / BATTLES">
          <span class="showbar-round">{String(props.roundNumber).padStart(2, '0')}</span>
          {PHASE_LABEL[props.state]}
        </Show>
      </strong>
      <Show when={props.connection !== 'live'}>
        <span class="showbar-connection">
          {props.connection === 'polling' ? 'Backup connection' : 'Connecting…'}
        </span>
      </Show>
    </div>
    <Show when={props.countdownSeconds !== null}>
      <span class="showbar-timer mono" role="timer">
        {props.countdownSeconds}s
      </span>
    </Show>
    <div class="showbar-tools">
      <button
        type="button"
        class="btn btn--ghost btn--icon"
        classList={{ 'is-off': !props.musicEnabled }}
        aria-pressed={props.musicEnabled}
        aria-label={props.musicEnabled ? 'Mute background music' : 'Play background music'}
        title={props.musicEnabled ? 'Mute music' : 'Play music'}
        onClick={props.onToggleMusic}
      >
        <span aria-hidden="true">{props.musicEnabled ? '♪' : '♪̸'}</span>
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--icon"
        aria-label="Leave this room and start a new one"
        title="New room"
        onClick={() => {
          if (
            window.confirm('Leave this room and start a new one? Players will need the new code.')
          ) {
            props.onNewRoom();
          }
        }}
      >
        <span aria-hidden="true">＋</span>
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--icon showbar-fullscreen"
        aria-label={props.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={props.fullscreen ? 'Exit fullscreen (F)' : 'Present fullscreen (F)'}
        onClick={props.onToggleFullscreen}
      >
        <span aria-hidden="true">{props.fullscreen ? '⤡' : '⤢'}</span>
      </button>
    </div>
  </header>
);
