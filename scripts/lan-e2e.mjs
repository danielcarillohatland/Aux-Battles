// FULL LAN E2E — replicates the browser flow exactly over 192.168.0.122:5173:
// create → host WS connect (LAN) → player joins via LAN REST → does the host's
// snapshot update from 0 players to 1?
import WebSocket from 'ws';

const HOST = '192.168.0.122:5173';
const API = `http://${HOST}/api/v1`;
const j = async (res) => {
  const b = await res.json();
  if (!b.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(b)}`);
  return b.data;
};

const created = await j(
  await fetch(`${API}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
);
console.log('1. room created:', created.code);
const { code, hostToken } = created;

const player = await j(
  await fetch(`${API}/rooms/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, nickname: 'LanLarry' }),
  }),
);
console.log('2. player joined:', player.nickname);

const ticketed = await j(
  await fetch(`${API}/ws-ticket`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${hostToken}`,
    },
    body: JSON.stringify({ code }),
  }),
);

let sawPlayer = false;
const ws = new WebSocket(`ws://${HOST}/ws?room=${code}&ticket=${ticketed.ticket}`);
const timer = setTimeout(() => {
  console.log(
    sawPlayer ? 'PASS (already seen)' : 'FAIL TIMEOUT: host snapshot still shows 0 players',
  );
  process.exit(sawPlayer ? 0 : 1);
}, 8000);

ws.on('open', () => console.log('3. host WS upgraded via LAN'));
ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.t !== 'state_change') return;
  const names = (f.snapshot.players ?? []).map((p) => p.nickname);
  console.log(`   frame: state=${f.snapshot.state} players=[${names.join(', ')}]`);
  if (names.includes('LanLarry')) {
    sawPlayer = true;
    console.log('4. PASS: host sees LanLarry in roster over LAN');
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
