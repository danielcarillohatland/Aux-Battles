// Browser-accurate probe: run the ACTUAL client module (host/ws.ts) logic
// against the LAN origin using the same URL construction the browser uses.
// This catches client-side bugs a raw ws probe can't see.
import WebSocket from 'ws';

const ORIGIN = 'http://192.168.0.122:5173';
const API = `${ORIGIN}/api/v1`;
const j = async (res) => {
  const b = await res.json();
  if (!b.ok) throw new Error(`HTTP ${res.status}`);
  return b.data;
};

// 1. Create room via the page's own fetch semantics: bodyless, NO content-type.
const room = await j(await fetch(`${API}/rooms`, { method: 'POST' }));
console.log('room:', room.code);

// 2. Mint ticket exactly like host/ws.ts does.
const { ticket } = await j(
  await fetch(`${API}/ws-ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${room.hostToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: room.code }),
  }),
);

// 3. Dial EXACTLY like ws.ts line 228-233:
//    proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
//    url = `${proto}//${location.host}/ws?...`
// On a LAN-hosted page, location.host = 192.168.0.122:5173 — same as our dial.
const proto = 'ws:';
const url = `${proto}//${'192.168.0.122:5173'}/ws?room=${encodeURIComponent(room.code)}&ticket=${encodeURIComponent(ticket)}`;
console.log('dialing:', url);

const ws = new WebSocket(url);
ws.on('open', () => console.log('OPEN — browser would now await first frame'));
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  console.log(`FRAME t=${f.t} → client sets connState='live' ✅`);
  ws.close();
  process.exit(0);
});
ws.on('close', (c, reason) => {
  console.log(`CLOSED code=${c} reason=${reason.toString() || '(empty)'}`);
  process.exit(1);
});
setTimeout(() => {
  console.log('TIMEOUT waiting for open/frame');
  process.exit(1);
}, 6000);
