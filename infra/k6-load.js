import http from 'k6/http';
import { check, sleep } from 'k6';
import WebSocket from 'k6/experimental/websockets';

export const options = {
  scenarios: {
    party_rooms: { executor: 'constant-vus', vus: 50, duration: '60s', gracefulStop: '5s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:8787';
const wsBase = base.replace(/^http/, 'ws');
const PLAYERS = 8;

function freshIp() {
  // Unique per VU *per iteration* — the create limiter allows 10/hour/IP, and
  // each iteration runs a full room lifecycle, so every iteration needs its
  // own IP. __ITER is unbounded; embed it in octets 2+3 (base 250) with VU in
  // oct4: capacity = 250 * 250 * 62500 unique IPs.
  const it = __ITER;
  return `10.${Math.floor(it / 250) % 250}.${it % 250}.${__VU % 250}`;
}

export default function () {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': freshIp() };
  const created = http.post(`${base}/api/v1/rooms`, '{}', { headers });
  if (!check(created, { 'room created': (r) => r.status === 201 })) return;
  const code = created.json('data.code');
  const hostToken = created.json('data.hostToken');

  const tokens = [];
  for (let player = 0; player < PLAYERS; player += 1) {
    const joined = http.post(
      `${base}/api/v1/rooms/${code}/join`,
      JSON.stringify({ nickname: `v${__VU}i${__ITER}p${player}` }),
      { headers },
    );
    if (!check(joined, { 'player joined': (r) => r.status === 200 })) return;
    tokens.push(joined.json('data.playerToken'));
  }

  let open = 0;
  const sockets = [];
  for (const token of tokens) {
    const ticketed = http.post(`${base}/api/v1/ws-ticket`, JSON.stringify({ code }), {
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
    if (!check(ticketed, { 'ws ticket minted': (r) => r.status === 200 })) continue;
    const socket = new WebSocket(
      `${wsBase}/ws?room=${code}&ticket=${ticketed.json('data.ticket')}`,
    );
    socket.addEventListener('open', () => {
      open += 1;
    });
    sockets.push(socket);
  }
  for (let waited = 0; waited < 50 && open < sockets.length; waited += 1) sleep(0.1);

  const hostHeaders = { ...headers, authorization: `Bearer ${hostToken}` };
  const hostCall = (action, body) =>
    http.post(`${base}/api/v1/rooms/${code}/host/${action}`, JSON.stringify(body), {
      headers: hostHeaders,
    });

  check(hostCall('start_game', {}), { 'start_game ok': (r) => r.status === 200 });
  check(hostCall('pick_category', { category: `load test round ${__ITER}` }), {
    'pick_category ok': (r) => r.status === 200,
  });
  check(hostCall('skip_phase', {}), { 'skip_phase ok': (r) => r.status === 200 });

  tokens.forEach((token, player) => {
    const submitted = http.post(
      `${base}/api/v1/rooms/${code}/rounds/0/submissions`,
      JSON.stringify({
        clientMsgId: `cm-${code}-${__VU}-${__ITER}-p${player}`,
        track: {
          id: `tr-${player}`,
          title: `Track ${player}`,
          artist: 'k6 choir',
          durationMs: 180000,
        },
      }),
      { headers: { ...headers, authorization: `Bearer ${token}` } },
    );
    check(submitted, { 'submission accepted': (r) => r.status === 200 });
  });

  check(hostCall('begin_playback', {}), { 'begin_playback ok': (r) => r.status === 200 });

  for (const socket of sockets) socket.close();
}
