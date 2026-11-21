// Benchmark: row lock vs atomic update, 500 concurrent requests for 100 seats, repeated runs.
// Each run uses a fresh event; the order of the two strategies alternates to cancel out warm-up effects.
// Results are printed and written to docs/benchmark-latest.md for the report.
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const RUNS = Number(process.env.BENCH_RUNS) || 5;
const SEATS = 100;
const USERS = 500;

h.run(`Benchmark: ${USERS} concurrent requests, ${SEATS} seats, ${RUNS} runs per strategy`, async (t) => {
  const org = await h.orgLogin();
  console.log(`  preparing ${USERS} students...`);
  const studs = await h.students('scale', USERS);
  const cookies = studs.map((s) => s.cookie);

  const results = { rowlock: [], atomic: [] };

  for (let i = 0; i < RUNS; i++) {
    const order = i % 2 === 0 ? ['rowlock', 'atomic'] : ['atomic', 'rowlock'];
    for (const strategy of order) {
      const eventId = await h.createEvent(org, { seats: SEATS, title: `bench-${strategy}` });
      try {
        const r = await h.fireAll(eventId, cookies, strategy);
        const rec = await h.reconcile(eventId);
        const correct = r.tally[201] === SEATS && r.tally[409] === USERS - SEATS && Object.keys(r.tally).length === 2 && rec.ok && rec.seats_left === 0;
        results[strategy].push({ ...r, correct });
        console.log(`  run ${i + 1} ${strategy.padEnd(7)} ${r.totalMs.toFixed(0).padStart(5)} ms  ${r.rps.toFixed(0).padStart(4)} req/s  p50 ${r.p50.toFixed(0).padStart(4)}  p95 ${r.p95.toFixed(0).padStart(4)}  ${correct ? 'correct' : 'INCORRECT'}`);
      } finally {
        await h.cleanupEvents([eventId]);
      }
    }
  }

  const summary = {};
  for (const s of ['rowlock', 'atomic']) {
    const rs = results[s];
    summary[s] = {
      ms: h.median(rs.map((r) => r.totalMs)),
      rps: h.median(rs.map((r) => r.rps)),
      p50: h.median(rs.map((r) => r.p50)),
      p95: h.median(rs.map((r) => r.p95)),
      ok: rs.every((r) => r.correct),
    };
  }

  const faster = summary.atomic.ms < summary.rowlock.ms ? 'atomic' : 'rowlock';
  const gap = (Math.abs(summary.atomic.ms - summary.rowlock.ms) / Math.max(summary.atomic.ms, summary.rowlock.ms)) * 100;

  const row = (name, s) => `| ${name} | ${s.ms.toFixed(0)} | ${s.rps.toFixed(0)} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${s.ok ? `${RUNS}/${RUNS}` : 'FAILED'} |`;
  const md = [
    '# Benchmark results',
    '',
    `${USERS} concurrent booking requests for ${SEATS} seats (one hot event), ${RUNS} runs per strategy, median shown.`,
    `Connection pool: 20. Generated ${new Date().toISOString()} on Node ${process.version}.`,
    '',
    '| Strategy | Total (ms) | Throughput (req/s) | p50 latency (ms) | p95 latency (ms) | Correct runs |',
    '|---|---|---|---|---|---|',
    row('Row lock (`SELECT ... FOR UPDATE`)', summary.rowlock),
    row('Atomic update (`UPDATE ... WHERE seats_left > 0`)', summary.atomic),
    '',
    `Faster in this run: **${faster}** (${gap.toFixed(0)}% lower total time).`,
    'Every request contends for the same event row, so latencies include time spent queueing for the lock and for one of the 20 pooled connections. Treat the gap as indicative, not a universal constant.',
    '',
  ].join('\n');

  console.log(`\n  median over ${RUNS} runs`);
  console.log(md.split('\n').slice(5, 9).map((l) => `  ${l}`).join('\n'));
  console.log(`  faster: ${faster} (${gap.toFixed(0)}% lower total time)`);

  fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'benchmark-latest.md'), md);
  console.log('  wrote docs/benchmark-latest.md');

  t.check('every run of both strategies was correct (100 x 201, 400 x 409, reconciled)', summary.rowlock.ok && summary.atomic.ok);
});
