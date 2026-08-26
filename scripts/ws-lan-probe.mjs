// LAN-path WS probe: dial the Vite proxy via the LAN IP (192.168.0.122:5173),
// the EXACT path a phone/LAN-host browser takes. Not localhost.
import WebSocket from 'ws';

const [code, ticket, host] = process.argv.slice(2);
const origin = `http://${host}:5173`;
const ws = new WebSocket(`ws://${host}:5173/ws?room=${code}&ticket=${ticket}`, {
  headers: { origin },
});
const timer = setTimeout(() => {
  console.log('FAIL TIMEOUT: no open+frame within 6s');
  process.exit(1);
}, 6000);
ws.on('open', () => console.log('1. UPGRADE OK (LAN path)'));
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  console.log(
    `2. FIRST FRAME: ${f.t} | state=${f.snapshot?.state} | players=${f.snapshot?.players?.length}`,
  );
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  console.log('WS ERROR:', e.message);
  clearTimeout(timer);
  process.exit(1);
});
ws.on('unexpected-response', (_, res) => {
  console.log(`UPGRADE REJECTED: HTTP ${res.statusCode}`);
  clearTimeout(timer);
  process.exit(1);
});
