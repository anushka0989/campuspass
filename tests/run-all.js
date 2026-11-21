// npm test: starts the server on a spare port (unless BASE_URL is given), runs every test, prints a summary.
// Needs DATABASE_URL (from .env) pointing at a database that already has the schema applied.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || '3099';
const external = Boolean(process.env.BASE_URL);
const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT,
  ORGANIZER_CODE: process.env.ORGANIZER_CODE || 'test-invite-code',
  BASE_URL: process.env.BASE_URL || `http://localhost:${PORT}`,
  BENCH_RUNS: process.env.BENCH_RUNS || '3',
};

const SUITE = [
  ['Auth, permissions, validation', 'authz.js'],
  ['Smoke: 1 seat, 2 requests', 'smoke.js'],
  ['Scale: 100 seats, 500 requests (row lock)', 'scale.js', 'rowlock'],
  ['Scale: 100 seats, 500 requests (atomic)', 'scale.js', 'atomic'],
  ['Naive baseline (race demonstration)', 'scale.js', 'naive'],
  ['Cancel-vs-book race x25', 'cancel-vs-book.js'],
  ['Waitlist', 'waitlist.js'],
  ['Per-student booking limit', 'limit.js'],
  ['QR check-in (HMAC)', 'checkin.js'],
  ['Organizer controls (overrides, lock mode, approval)', 'organizer-controls.js'],
  ['Benchmark (row lock vs atomic)', 'bench.js'],
  ['Database invariants', 'invariants.js'],
];

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${env.BASE_URL}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start in time');
}

(async () => {
  let server = null;
  let serverLog = '';
  if (!external) {
    server = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
  }

  const results = [];
  try {
    await waitForServer();
    console.log(`Running ${SUITE.length} test files against ${env.BASE_URL}\n`);
    for (const [label, file, ...args] of SUITE) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { cwd: root, env, stdio: 'inherit' });
      results.push({ label, ok: r.status === 0, secs: ((Date.now() - t0) / 1000).toFixed(1) });
    }
  } catch (e) {
    console.error(e.message);
    if (serverLog) console.error(serverLog.split('\n').slice(-20).join('\n'));
    results.push({ label: 'startup', ok: false, secs: '0' });
  } finally {
    if (server) server.kill('SIGTERM');
  }

  console.log('\n================ SUMMARY ================');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(44)} ${r.secs}s`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nAll ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();