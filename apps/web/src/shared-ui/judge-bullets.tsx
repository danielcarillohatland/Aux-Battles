/** Four one-line judge bullets (D-032); older results without bullets fall back to prose. */
import { For, Show } from 'solid-js';
import './judge-status.css';

export interface JudgeLines {
  reasons?: string[] | undefined;
  defenseNote?: string | undefined;
  verdict?: string | undefined;
  explanation: string;
  judgeModel?: string | undefined;
  confidence?: 'high' | 'medium' | 'low' | undefined;
}

export function JudgeBullets(props: { judgement: JudgeLines }) {
  const reasons = () => props.judgement.reasons ?? [];
  return (
    <div class="judge-reasoning">
      <Show when={props.judgement.judgeModel}>
        <p
          class="judge-source"
          classList={{
            'judge-source--offline': props.judgement.judgeModel?.startsWith('fallback'),
          }}
        >
          {props.judgement.judgeModel?.startsWith('crowd-')
            ? 'Room vote'
            : props.judgement.judgeModel?.startsWith('fallback')
              ? 'Offline scoring'
              : 'AI verdict'}
        </p>
      </Show>
      <Show when={props.judgement.confidence === 'low'}>
        <p class="judge-confidence" role="note">
          DJ AUX did not recognize this song, so sound and lyrics were scored neutral.
        </p>
      </Show>
      <Show
        when={reasons().length > 0}
        fallback={<p class="judge-explanation">{props.judgement.explanation}</p>}
      >
        <ul class="judge-bullets">
          <For each={reasons()}>{(reason) => <li>{reason}</li>}</For>
          <Show when={props.judgement.defenseNote}>
            {(note) => (
              <li>
                <span class="judge-bullet-label">Defense</span>
                {note()}
              </li>
            )}
          </Show>
          <Show when={props.judgement.verdict}>
            {(verdict) => (
              <li class="judge-bullet-verdict">
                <span class="judge-bullet-label">Verdict</span>
                {verdict()}
              </li>
            )}
          </Show>
        </ul>
      </Show>
    </div>
  );
}
