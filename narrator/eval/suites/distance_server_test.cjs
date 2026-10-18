// Real server.js over HTTP: ESP8266 POST /distance → /api/distance/stream (SSE). eval/run.cjs starts the server on TEST_PORT / TEST_DISTANCE_PORT.
const PORT = process.env.TEST_PORT || 18080, DPORT = process.env.TEST_DISTANCE_PORT || 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };
const post = (port, body) => fetch(`http://localhost:${port}/distance`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
async function openStream(onEvent) {
  const ac = new AbortController();
  const r = await fetch(`http://localhost:${PORT}/api/distance/stream`, { signal: ac.signal });
  (async () => { let buf = ''; const dec = new TextDecoder(); try { for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/^data: (.*)$/m); if (m) onEvent(JSON.parse(m[1]), performance.now()); } } } catch {} })();
  return { type: r.headers.get('content-type'), close: () => ac.abort() };
}
(async () => {
  const got = [];
  const s = await openStream((e, t) => got.push({ e, t }));
  check('stream is text/event-stream', s.type.startsWith('text/event-stream'), s.type);
  await sleep(100);
  const t0 = performance.now(); const r1 = await post(DPORT, 'distance=0.420');
  await sleep(100);
  check('ESP-style POST on the ESP port → 204', r1.status === 204, r1.status);
  check('reading pushed to the phone stream', got.at(-1)?.e.metres === 0.42, JSON.stringify(got));
  check('pushed within 50 ms of the POST', got.at(-1) && got.at(-1).t - t0 < 50, got.at(-1) && Math.round(got.at(-1).t - t0) + ' ms');
  const r2 = await post(PORT, 'distance=Out_of_Range'); await sleep(100);
  check('Out_of_Range (on the main port) → metres null', r2.status === 204 && got.at(-1)?.e.metres === null, JSON.stringify(got.at(-1)));
  for (const bad of ['distance=abc', 'distance=-1', 'foo=1', 'distance=']) { const r = await post(DPORT, bad); check(`bad body "${bad}" → 400`, r.status === 400, r.status); }
  await post(DPORT, 'distance=1.234');
  const late = []; const s2 = await openStream((e) => late.push(e)); await sleep(150);
  check('new phone gets the latest reading on connect', late[0]?.metres === 1.234, JSON.stringify(late));
  // ESP rate: 5 readings/s for 2 s, all delivered in order
  const before = got.length; for (let i = 0; i < 10; i++) { await post(DPORT, `distance=${(2 - i * 0.1).toFixed(3)}`); await sleep(200); }
  await sleep(100);
  const seq = got.slice(before).map((g) => g.e.metres);
  check('10 readings at ESP rate delivered in order', seq.length === 10 && seq.every((v, i) => Math.abs(v - (2 - i * 0.1)) < 1e-9), JSON.stringify(seq));
  s.close(); s2.close();
  console.log(`${pass}/${total}`); process.exit(0);
})();
