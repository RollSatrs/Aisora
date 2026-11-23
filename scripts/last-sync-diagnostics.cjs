'use strict';

/** Print a redacted summary of the most recent local Aisora sync diagnostics. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.cwd(), 'artifacts', 'sync-diagnostics');
if (!fs.existsSync(root)) {
  console.error('No diagnostics yet. Enable AIS_SYNC_DIAGNOSTICS_ENABLED=true and run /sync.');
  process.exit(1);
}
const dirs = fs.readdirSync(root).filter((name) => name.startsWith('run-')
  && fs.existsSync(path.join(root, name, 'report.json'))).sort();
if (!dirs.length) {
  console.error('No completed diagnostic reports found.');
  process.exit(1);
}
const latest = path.join(root, dirs[dirs.length - 1]);
const report = JSON.parse(fs.readFileSync(path.join(latest, 'report.json'), 'utf8'));
const events = Array.isArray(report.events) ? report.events : [];
const aggregate = new Map();
for (const event of events) {
  const key = `${event.category}: ${event.label}`;
  const entry = aggregate.get(key) ?? { calls: 0, totalMs: 0, maxMs: 0, failed: 0 };
  entry.calls++;
  entry.totalMs += event.durationMs ?? 0;
  entry.maxMs = Math.max(entry.maxMs, event.durationMs ?? 0);
  if (event.status === 'failed') entry.failed++;
  aggregate.set(key, entry);
}
console.log('Aisora diagnostics:', path.basename(latest));
console.log('Elapsed (browser scan):', Math.round(report.elapsedMs / 1000), 'seconds');
console.log('Trace locally available:', report.traceSaved ? 'yes' : 'no');
console.log('Network counters:', report.networkCounts);
console.log('Instrumented operations:', events.length);
console.log('\nTop recorded time consumers (overlapping steps may appear twice):');
const rows = [...aggregate.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 20);
for (const [label, entry] of rows) {
  console.log(`${String(entry.totalMs).padStart(8)}ms | ${String(entry.calls).padStart(4)} calls | max ${String(entry.maxMs).padStart(6)}ms | ${String(entry.failed).padStart(2)} failures | ${label}`);
}
console.log('\nSanitized report:', path.join(latest, 'report.json'));
if (report.traceSaved) {
  console.log('Trace Viewer: pnpm exec playwright show-trace "' + path.join(latest, 'trace.zip') + '"');
  console.log('WARNING: trace.zip contains private AIS data. Keep it on your Mac, do not upload.');
}
