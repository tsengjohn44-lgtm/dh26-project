#!/usr/bin/env node
// One command for every offline check: syntax, then each suite in suites/ in its own Node process.
// Every check prints as it runs (✓ / ✗ and its name), a summary table follows, and the full
// transcript is saved to results/ so a run can be read again later.
//
//   node narrator/eval/run.cjs                 all offline suites (no API calls, ~1 min)
//   node narrator/eval/run.cjs --list          what each suite covers
//   node narrator/eval/run.cjs --only beeper,filter_prompt
//   node narrator/eval/run.cjs --quiet         only failing checks + the summary
//   node narrator/eval/run.cjs --api           also run api_eval.cjs (real Perceptron calls, uses credits)
//
// Exit code 0 only if every suite passed.
const fs = require('fs'), path = require('path'), { spawn, execFileSync } = require('child_process');

const EVAL = __dirname, NARRATOR = path.join(EVAL, '..'), RESULTS = path.join(EVAL, 'results');
// Spare ports so a server you already have running on 8080/8443/5000 is left alone.
const TEST_PORTS = { PORT: '18080', HTTPS_PORT: '18443', DISTANCE_PORT: '15000' };
// Generous: app_test is the slowest at ~40 s. A hung suite fails instead of blocking the run.
const SUITE_TIMEOUT_MS = 180_000;

const SUITES = [
  { name: 'filter_prompt', file: 'filter_prompt_test.cjs', covers: 'filter.js repeat/n-a rules, stair count and label; prompt.js payloads and sensor paragraph' },
  { name: 'app', file: 'app_test.cjs', covers: 'real app.js in a fake browser: camera races, orientation/flip, blur gate, reasoning modes, Fast + Low, Ask, sensor, pause while speaking, History' },
  { name: 'speech_queue', file: 'speech_queue_test.cjs', covers: 'speech.js: first-chunk start, in-order playback, no loss, odd byte splits, interrupt, retry, cancel' },
  { name: 'speech_priority', file: 'speech_priority_test.cjs', covers: 'speech.js: hazard clips cut non-hazard speech, never other hazards' },
  { name: 'speech_stall', file: 'speech_stall_test.cjs', covers: 'speech.js: a stalled download is given up so the queue drains' },
  { name: 'beeper', file: 'beeper_test.cjs', covers: 'beeper.js: beep curve, scheduler, ducking, stale sensor, Beeper.reading' },
  { name: 'recorder', file: 'recorder_test.cjs', covers: 'recorder.js: end-of-speech detection on synthetic audio, silence trim' },
  { name: 'ui', file: 'ui_test.cjs', covers: 'ui.js: settings sheet, segmented control, tap to repeat, hazard highlight, vibration' },
  { name: 'history_ui', file: 'history_ui_test.cjs', covers: 'ui.js + log.js: History sheet' },
  { name: 'log', file: 'log_test.cjs', covers: 'log.js: storage, cap, filters, corrupt or blocked storage' },
  { name: 'distance_server', file: 'distance_server_test.cjs', server: true, covers: 'real server.js: ESP POST /distance → SSE stream, bad input, latest reading on connect' },
];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean) : [];
if (args.includes('--only') && !only.length) { console.error('--only needs suite names, e.g. --only beeper,log'); process.exit(2); }

if (flag('--list')) {
  for (const s of SUITES) console.log(`${s.name.padEnd(16)} suites/${s.file}\n${' '.repeat(17)}${s.covers}`);
  console.log(`${'api (--api)'.padEnd(16)} api_eval.cjs\n${' '.repeat(17)}real Perceptron calls on test photos: length, n/a on repeat, step counts, latency`);
  process.exit(0);
}

const unknown = only.filter((n) => !SUITES.some((s) => s.name === n));
if (unknown.length) { console.error(`Unknown suite(s): ${unknown.join(', ')}. See --list.`); process.exit(2); }
const selected = only.length ? SUITES.filter((s) => only.includes(s.name)) : SUITES;

// Everything printed goes to the terminal and to the transcript.
const transcript = [];
const out = (line = '') => { transcript.push(line); console.log(line); };
const quiet = flag('--quiet');

function header() {
  let commit = 'unknown', dirty = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: NARRATOR }).toString().trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: NARRATOR }).toString().trim() ? ' + uncommitted changes' : '';
  } catch {}
  out(`Scene Narrator checks · ${new Date().toISOString()} · git ${commit}${dirty} · node ${process.version}`);
}

// Step 1: every source file must parse. Catches typos before any suite gives a confusing failure.
function syntaxCheck() {
  const files = ['server.js', 'prompt.js', ...fs.readdirSync(path.join(NARRATOR, 'public')).filter((f) => f.endsWith('.js')).map((f) => `public/${f}`)];
  out(`\n── syntax (node --check, ${files.length} files)`);
  const bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', path.join(NARRATOR, f)], { stdio: 'pipe' }); }
    catch (e) { bad.push(f); out(`✗ ${f}\n${e.stderr.toString().trim()}`); }
  }
  if (!bad.length) out(`✓ all ${files.length} files parse`);
  return { name: 'syntax', pass: files.length - bad.length, fail: bad.length, ms: 0, ok: !bad.length, note: '' };
}

// The distance suite needs the real server. Started on spare ports; a dummy key is enough
// because that suite never calls Perceptron (a real key from .env is used if present).
async function startServer() {
  const env = { ...process.env, ...TEST_PORTS, PERCEPTRON_API_KEY: process.env.PERCEPTRON_API_KEY || readEnvKey() || 'offline-test' };
  const child = spawn(process.execPath, ['server.js'], { cwd: NARRATOR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
    try { if ((await fetch(`http://localhost:${TEST_PORTS.PORT}/`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill(); throw new Error(`server did not start in 5 s:\n${log}`);
}
function readEnvKey() {
  try { return fs.readFileSync(path.join(NARRATOR, '.env'), 'utf8').match(/^\s*PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/m)?.[1]; } catch { return null; }
}

// Runs one script; a suite passes when it exits 0, prints no ✗, and prints its final "pass/total".
function runScript(name, file, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], { cwd: NARRATOR, env: { ...process.env, ...env } });
    let pass = 0, fail = 0, summary = null, buf = '';
    const onLine = (line) => {
      if (line.startsWith('✓')) pass++;
      else if (line.startsWith('✗')) fail++;
      const m = line.match(/^(\d+)\/(\d+)$/); if (m) summary = m;
      transcript.push(`  ${line}`);
      if (!quiet || !line.startsWith('✓')) console.log(`  ${line}`);
    };
    const onData = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { onLine(`✗ timed out after ${SUITE_TIMEOUT_MS / 1000} s`); child.kill(); }, SUITE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer); if (buf) onLine(buf);
      const notes = [];
      if (code !== 0) notes.push(`exit ${code}`);
      if (!summary) notes.push('no pass/total line (crashed?)');
      else if (+summary[1] !== pass || +summary[2] !== pass + fail) notes.push(`suite reported ${summary[0]}`);
      resolve({ name, pass, fail, ms: Date.now() - t0, ok: code === 0 && fail === 0 && !!summary && pass > 0, note: notes.join(', ') });
    });
  });
}

(async () => {
  header();
  const rows = [syntaxCheck()];
  let server = null;
  try {
    for (const s of selected) {
      out(`\n── ${s.name}  (suites/${s.file})\n   ${s.covers}`);
      if (s.server && !server) {
        try { server = await startServer(); out(`   server.js started on :${TEST_PORTS.PORT} / distance :${TEST_PORTS.DISTANCE_PORT}`); }
        catch (e) { out(`✗ ${e.message}`); rows.push({ name: s.name, pass: 0, fail: 1, ms: 0, ok: false, note: 'server failed to start' }); continue; }
      }
      rows.push(await runScript(s.name, path.join(EVAL, 'suites', s.file), { TEST_PORT: TEST_PORTS.PORT, TEST_DISTANCE_PORT: TEST_PORTS.DISTANCE_PORT }));
    }
    if (flag('--api')) {
      out('\n── api  (api_eval.cjs, real Perceptron calls)');
      rows.push(await runScript('api', path.join(EVAL, 'api_eval.cjs')));
    }
  } finally { if (server) server.kill(); }

  out('\n── summary');
  out(`${'suite'.padEnd(16)} ${'result'.padEnd(6)} ${'passed'.padStart(7)} ${'failed'.padStart(6)} ${'time'.padStart(7)}  note`);
  for (const r of rows) out(`${r.name.padEnd(16)} ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)} ${String(r.pass).padStart(7)} ${String(r.fail).padStart(6)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.note}`);
  const allOk = rows.every((r) => r.ok);
  const totals = rows.reduce((a, r) => [a[0] + r.pass, a[1] + r.fail], [0, 0]);
  out(`\n${allOk ? 'ALL PASSED' : 'FAILURES'}: ${totals[0]} checks passed, ${totals[1]} failed`);

  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${new Date().toISOString().replace(/[:.]/g, '-')}${flag('--api') ? '-api' : ''}.log`);
  fs.writeFileSync(file, transcript.join('\n') + '\n');
  console.log(`Transcript: ${path.relative(process.cwd(), file)}`);
  process.exit(allOk ? 0 : 1);
})();
