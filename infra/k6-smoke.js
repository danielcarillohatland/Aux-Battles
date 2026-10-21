import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    party_rooms: { executor: 'constant-vus', vus: 50, duration: '20s', gracefulStop: '5s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:8787';

export default function () {
  const ip = `10.${Math.floor(__VU / 250)}.${__VU % 250}.${(__ITER % 250) + 1}`;
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  const created = http.post(`${base}/api/v1/rooms`, '{}', { headers });
  if (!check(created, { 'room created': (r) => r.status === 201 })) return;
  const code = created.json('data.code');
  for (let player = 0; player < 8; player += 1) {
    const joined = http.post(
      `${base}/api/v1/rooms/${code}/join`,
      JSON.stringify({ nickname: `v${__VU}-p${player}` }),
      { headers },
    );
    check(joined, { 'player joined': (r) => r.status === 200 });
  }
}
