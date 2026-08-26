// Ticket lifecycle probes: reuse must be rejected; unknown room rejected.
import WebSocket from 'ws';

const [code, usedTicket] = process.argv.slice(2);
const ws = new WebSocket(`ws://localhost:5173/ws?room=${code}&ticket=${usedTicket}`);
const timer = setTimeout(() => {
  console.log('FAIL: reused ticket was accepted (should be rejected)');
  process.exit(1);
}, 4000);
ws.on('open', () => {
  console.log('FAIL: upgraded with a consumed ticket');
  clearTimeout(timer);
  ws.close();
  process.exit(1);
});
ws.on('error', () => {});
ws.on('unexpected-response', (_, res) => {
  console.log(`PASS: consumed ticket rejected at upgrade — HTTP ${res.statusCode}`);
  clearTimeout(timer);
  process.exit(0);
});
