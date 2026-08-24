import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { NICKNAME_MAX, NicknameSchema } from '@aux/shared';
import '../shared-ui/shell.css';

// Player join shell: nickname validation already runs on the shared schema —
// one protocol truth from day one (D-D). Full join flow lands Phase 1.

const [nick, setNick] = createSignal('');
const [valid, setValid] = createSignal<boolean | null>(null);

const check = (v: string) => {
  setNick(v);
  setValid(v.length > 0 ? NicknameSchema.safeParse(v).success : null);
};

const App = () => (
  <div class="card">
    <h1>AUX BATTLES</h1>
    <p class="sub">Player join — scanning comes in Phase 1.</p>
    <input
      placeholder="Nickname"
      value={nick()}
      onInput={(e) => check(e.currentTarget.value)}
      aria-label="Nickname"
      maxLength={NICKNAME_MAX}
    />
    <p>{valid() === false ? 'Pick a shorter nickname' : valid() === true ? 'Looks good ✓' : ''}</p>
  </div>
);

render(() => <App />, document.getElementById('root') as HTMLElement);
