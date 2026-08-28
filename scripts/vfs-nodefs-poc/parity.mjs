/**
 * Parity check: does the TypeScript port measure what the proof of concept did?
 *
 * The port is a translation — retyped, with `node:fs` moved behind
 * `desktopRequire` so the mobile-import gate stays clean. A translation can be
 * wrong in ways nothing else here would catch: the unit tests run against a fake
 * filesystem, and the only other check is opening the real vault's cache in
 * Obsidian, which is an expensive place to discover a transposed argument.
 *
 * So this runs src/database/storage/vfs/nodeFsVfs.ts against the same WASM
 * artifact, on the same shaped database, and asserts the same numbers the PoC
 * produced. Two shims stand in for the renderer: env-shim.mjs for the Electron
 * environment the WASM build insists on, and a `window.activeWindow.require`
 * that hands `desktopRequire` the real Node modules.
 *
 *   node scripts/vfs-nodefs-poc/parity.mjs
 */
import './env-shim.mjs';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

// desktopRequire reads window.activeWindow.require. env-shim.mjs already made
// `window` globalThis, so this is the whole renderer contract it depends on.
globalThis.window.activeWindow = { require };

// Scratch beside this script, not in the caller's cwd: run from the repo root
// it would otherwise drop a bundle into the tree where eslint picks it up.
const ROOT = nodePath.join(import.meta.dirname, '.poc-data-parity');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const repoRoot = nodePath.resolve(import.meta.dirname, '../..');
const bundlePath = nodePath.join(ROOT, 'nodeFsVfs.bundle.mjs');
await build({
  entryPoints: [nodePath.join(repoRoot, 'src/database/storage/vfs/nodeFsVfs.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning'
});

const { installNodeFsVfs } = await import(bundlePath);

const wasmPath = require.resolve('@dao-xyz/sqlite3-vec/sqlite3.wasm');
const jsPath = wasmPath.replace(/sqlite3\.wasm$/, 'sqlite3.mjs');
const { default: sqlite3InitModule } = await import(jsPath);
const wasmBinary = readFileSync(wasmPath);
const sqlite3 = await sqlite3InitModule({
  instantiateWasm: (imports, cb) => {
    WebAssembly.instantiate(wasmBinary, imports).then(r => cb(r.instance));
    return {};
  },
  print: () => {},
  printErr: (m) => console.error('[SQLite]', m)
});

const { stats } = installNodeFsVfs(sqlite3, { vfsName: 'nexus-nodefs', root: ROOT });
const registered = sqlite3.capi.sqlite3_vfs_find('nexus-nodefs') !== 0;
console.log(`SQLite ${sqlite3.capi.sqlite3_libversion()} — VFS registered by the TS port: ${registered}`);

const DB_FILE = nodePath.join(ROOT, 'cache-parity.db');
const db = new sqlite3.oo1.DB(DB_FILE, 'c', 'nexus-nodefs');
db.exec(`
  PRAGMA page_size=4096;
  PRAGMA journal_mode=TRUNCATE;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE notes(id INTEGER PRIMARY KEY, path TEXT, body TEXT);
  CREATE INDEX idx_notes_path ON notes(path);
`);

const ROWS = 24000;
const body = 'x'.repeat(4000);
db.exec('BEGIN');
const insert = db.prepare('INSERT INTO notes(id, path, body) VALUES (?, ?, ?)');
for (let i = 1; i <= ROWS; i++) {
  insert.bind([i, `Notes/note-${i}.md`, body]);
  insert.stepReset();
}
insert.finalize();
db.exec('COMMIT');

const sizeOnDisk = db.selectValue('SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()');
console.log(`\nDatabase: ${ROWS.toLocaleString('en-US')} rows, ${sizeOnDisk.toLocaleString('en-US')} bytes on disk.`);

// One row changed — one reindexed note.
stats.reset();
const t0 = performance.now();
db.exec('BEGIN');
db.exec("UPDATE notes SET body = 'changed by the parity run' WHERE id = 42");
db.exec('COMMIT');
const vfsMs = performance.now() - t0;
const vfsBytes = stats.bytesWritten;
const vfsWrites = stats.writeCalls;
const vfsSyncs = stats.syncs;

const t1 = performance.now();
const exported = sqlite3.capi.sqlite3_js_db_export(db).buffer.byteLength;
const exportMs = performance.now() - t1;

const ratio = exported / vfsBytes;
console.log(`\n--- one single-row transaction ---`);
console.log(`node:fs VFS   : ${vfsBytes.toLocaleString('en-US')} bytes in ${vfsWrites} xWrite, ${vfsSyncs} fsync, ${vfsMs.toFixed(1)} ms`);
console.log(`whole export  : ${exported.toLocaleString('en-US')} bytes in ${exportMs.toFixed(1)} ms  (today's path)`);
console.log(`ratio         : ${Math.round(ratio)}x fewer bytes written by the VFS`);

const check1 = db.selectValue('PRAGMA integrity_check');
db.close();
const db2 = new sqlite3.oo1.DB(DB_FILE, 'w', 'nexus-nodefs');
const check2 = db2.selectValue('PRAGMA integrity_check');
const rows = db2.selectValue('SELECT COUNT(*) FROM notes');
const persisted = db2.selectValue("SELECT body FROM notes WHERE id = 42") === 'changed by the parity run';
db2.close();

console.log(`\nintegrity_check (open)     : ${check1}`);
console.log(`integrity_check (reopened) : ${check2}`);
console.log(`rows after reopening       : ${rows.toLocaleString('en-US')}`);
console.log(`update persisted (id=42)   : ${persisted ? 'yes' : 'no'}`);

// The PoC measured 4,843x on this exact shape. Anything in the same order of
// magnitude means the port did not lose the property; a collapse to single
// digits would mean it did.
const ok = registered && check1 === 'ok' && check2 === 'ok'
  && rows === ROWS && persisted && ratio > 1000;

console.log(`\nPARITY: ${ok ? 'GREEN' : 'RED'}`);
process.exit(ok ? 0 : 1);
