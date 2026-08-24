import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import '../shared-ui/shell.css';

// Phase 0 shell: proves the dual-entry build + @aux/shared import path.
// Real host flow (create room → QR → lobby) lands in Phase 1 (TASKS.md).

const [taps, setTaps] = createSignal(0);

const App = () => (
  <div class="card">
    <h1>AUX BATTLES</h1>
    <p class="sub">Host screen — Phase 1 brings the party.</p>
    <button type="button" onClick={() => setTaps((n) => n + 1)}>
      Host taps: {taps()}
    </button>
  </div>
);

render(() => <App />, document.getElementById('root') as HTMLElement);
