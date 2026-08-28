/**
 * Read the VFS cache's write-statistics record and say what it costs.
 *
 * The plugin writes one JSON line per save to `write-stats.jsonl` beside the
 * cache. This turns that file into an answer to the only question it exists for:
 * how much the page-level writes cost against what a whole-database export would
 * have cost at the same instants.
 *
 * A script rather than a console line inside the plugin. Obsidian's own plugin
 * guidelines ban routine `console.log`, and they are right — a save every half
 * hour narrating itself is noise for every user who is not measuring. The
 * numbers still have to be readable, so the recording lives in the plugin and
 * the reading lives here, where it costs a user nothing.
 *
 *   node scripts/cache-write-stats.mjs [path-to-write-stats.jsonl]
 *
 * With no argument it looks under this platform's application-data root and
 * reports every vault it finds there.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const APP_DIR_NAME = 'nexus-cache';
const STATS_FILE_NAME = 'write-stats.jsonl';

function appDataRoot() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP_DIR_NAME);
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_DIR_NAME);
}

function bytes(n) {
  const abs = Math.abs(n);
  if (abs < 1000) return `${n} B`;
  if (abs < 1e6) return `${(n / 1000).toFixed(1)} kB`;
  if (abs < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function report(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* a torn last line is not a reason to report nothing */ }
  }
  if (records.length === 0) {
    console.log(`${file}\n  no complete records yet\n`);
    return;
  }

  const written = records.reduce((a, r) => a + r.bytesWritten, 0);
  const counterfactual = records.reduce((a, r) => a + r.wouldHaveWrittenBytes, 0);
  const span = records.reduce((a, r) => a + r.sinceLastMs, 0);
  const last = records[records.length - 1];

  console.log(file);
  console.log(`  records          ${records.length}  (${records[0].at} -> ${last.at})`);
  console.log(`  database         ${bytes(last.dbSizeBytes)}`);
  console.log(`  written          ${bytes(written)} across ${records.reduce((a, r) => a + r.writeCalls, 0)} page writes`);
  console.log(`  exports avoided  ${bytes(counterfactual)}`);
  // Stated only when both sides are non-zero: a ratio against nothing written is
  // undefined, and printing a large number there would read as a measurement.
  if (written > 0) {
    console.log(`  ratio            ${(counterfactual / written).toFixed(1)}x less written than the blob path would have`);
  }
  if (span > 0) {
    console.log(`  rate             ${(written / (span / 1000) / 1000).toFixed(2)} kB/s over ${(span / 3600000).toFixed(1)}h of covered time`);
  }
  console.log('');
}

const explicit = process.argv[2];
if (explicit) {
  report(explicit);
} else {
  const root = appDataRoot();
  if (!existsSync(root)) {
    console.error(`No cache directory at ${root}. Nothing has run on the VFS on this machine.`);
    process.exit(1);
  }
  const found = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, STATS_FILE_NAME))
    .filter(existsSync);

  if (found.length === 0) {
    console.error(
      `No ${STATS_FILE_NAME} under ${root}. Either no save has happened yet this session, ` +
      'or this build predates the statistics.'
    );
    process.exit(1);
  }
  found.forEach(report);
}
