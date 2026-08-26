// Simulate the BROWSER host flow over LAN exactly:
// 1. GET /host.html from 192.168.0.122:5173 (page origin = LAN IP)
// 2. POST /api/v1/rooms (bodyless, no content-type — the fixed shape)
// 3. POST /api/v1/ws-ticket
// 4. WS dial ws://192.168.0.122:5173/ws WITH an Origin header like Safari sends
import WebSocket from 'ws';

const ORIGIN = 'http://192.168.0.122:5173';
const API = `${ORIGIN}/api/v1`;
const j = async (res) => {
  const b = await res.json();
  if (!b.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(b)}`);
  return b.data;
};

const created = await j(
  await fetch(`${API}/rooms`, { method: 'POST' }), // bodyless, no json header
);
console.log('1. room:', created.code, '| host token len:', created.hostToken.length);

const ticketed = await j(
  await fetch(`${API}/ws-ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${created.hostToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: created.code }),
  }),
);
console.log('2. ticket minted');

// Safari on the LAN page sends Origin: http://192.168.0.122:5173
const ws = new WebSocket(`ws://192.168.0.122:5173/ws?room=${created.code}&ticket=${ticketed.ticket}`, {
  headers: { origin: ORIGIN },
});
let opened = false;
const timer = setTimeout(() => {
  console.log('RESULT: socket never opened → upgrade rejected at/before Fastify');
  console.log('opened=', opened);
  process.exit(1);
}, 6000);

ws.on('open', () => {
  opened = true;
  console.log('3. WS UPGRADE OK with browser-style Origin');
});
ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  console.log(`4. FIRST FRAME ${f.t} state=${f.snapshot?.state} → client would flip to LIVE ✅`);
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on('unexpected-response', (_, res) => {
  console.log(`3b. UPGRADE REJECTED: HTTP ${res.statusCode}`);
});
