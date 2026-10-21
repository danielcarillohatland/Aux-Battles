// Raw WS handshake probe: does the upgrade succeed and does the first frame arrive?
import WebSocket from 'ws';

const [code, ticket] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:8787/ws?room=${code}&ticket=${ticket}`);
const timer = setTimeout(() => {
  console.log('TIMEOUT: no open+frame within 5s');
  process.exit(1);
}, 5000);
ws.on('open', () => console.log('UPGRADE OK'));
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  console.log(
    'FRAME:',
    f.t,
    '| state:',
    f.snapshot?.state,
    '| players:',
    f.snapshot?.players?.length,
  );
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  console.log('ERROR:', e.message);
  clearTimeout(timer);
  process.exit(1);
});
