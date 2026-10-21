// WS-through-Vite-proxy probe: the exact path a dev-mode host browser takes.
// Before the fix this hit Vite (no /ws route) and never upgraded.
import WebSocket from 'ws';

const [code, ticket] = process.argv.slice(2);
// Dial the VITE origin (5173) — the proxy must forward the upgrade to :8787.
const ws = new WebSocket(`ws://localhost:5173/ws?room=${code}&ticket=${ticket}`);
const timer = setTimeout(() => {
  console.log('FAIL: no open+frame within 5s (proxy not forwarding)');
  process.exit(1);
}, 5000);
ws.on('open', () => console.log('UPGRADE OK via Vite proxy'));
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  console.log('FIRST FRAME:', f.t, '| state:', f.snapshot?.state);
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  console.log('ERROR:', e.message);
  clearTimeout(timer);
  process.exit(1);
});
