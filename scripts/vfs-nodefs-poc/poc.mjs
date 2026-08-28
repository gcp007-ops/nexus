import './env-shim.mjs';
import { readFileSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { installNodeFsVfs } from './nodefs-vfs.mjs';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@dao-xyz/sqlite3-vec/sqlite3.wasm');
const jsPath = wasmPath.replace(/sqlite3\.wasm$/, 'sqlite3.mjs');
const { default: sqlite3InitModule } = await import(jsPath);

// Carregamento identico ao do SQLiteWasmBridge do Nexus: binario na mao,
// instanciado por instantiateWasm.
const wasmBinary = readFileSync(wasmPath);
const sqlite3 = await sqlite3InitModule({
  instantiateWasm: (imports, cb) => {
    WebAssembly.instantiate(wasmBinary, imports).then(r => cb(r.instance));
    return {};
  },
  print: () => {},
  printErr: (m) => console.error('[SQLite]', m)
});

const ROOT = path.join(process.cwd(), '.poc-data');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const { stats } = installNodeFsVfs(sqlite3, { vfsName: 'nodefs', root: ROOT });
console.log(`SQLite ${sqlite3.capi.sqlite3_libversion()} — VFS "nodefs" registrado:`,
  sqlite3.capi.sqlite3_vfs_find('nodefs') !== 0);

const DB_FILE = 'cache-poc.db';
const DB_PATH = path.join(ROOT, DB_FILE);
const fmt = (n) => n.toLocaleString('pt-BR');

// ---------------------------------------------------------------- montagem
const db = new sqlite3.oo1.DB(DB_FILE, 'c', 'nodefs');
db.exec(`
  PRAGMA journal_mode=TRUNCATE;
  PRAGMA synchronous=NORMAL;
  PRAGMA page_size=4096;
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    mtime INTEGER NOT NULL
  );
  CREATE INDEX idx_notes_path ON notes(path);
`);

// Enche ate a ordem de grandeza do cache real (~97 MB) para que a comparacao
// contra o export integral seja a mesma que a medida em producao.
const TARGET_BYTES = 90 * 1024 * 1024;
const CHUNK = 2000;
const filler = 'x'.repeat(2048);
let id = 0;
db.exec('BEGIN');
while (statSync(DB_PATH).size < TARGET_BYTES) {
  const stmt = db.prepare('INSERT INTO notes (id, path, content, mtime) VALUES (?,?,?,?)');
  try {
    for (let i = 0; i < CHUNK; i++) {
      stmt.bind([++id, `Producao/nota-${id}.md`, filler, Date.now()]);
      stmt.stepReset();
    }
  } finally { stmt.finalize(); }
  db.exec('COMMIT; BEGIN');
}
db.exec('COMMIT');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const dbBytes = statSync(DB_PATH).size;
const rows = db.selectValue('SELECT COUNT(*) FROM notes');
console.log(`\nBanco montado: ${fmt(rows)} linhas, ${fmt(dbBytes)} bytes em disco.`);

// -------------------------------------------------- medicao da transacao
// Uma nota reindexada — o gatilho que hoje custa a exportacao inteira.
stats.reset();
const t0 = performance.now();
db.exec('BEGIN');
const upd = db.prepare('UPDATE notes SET content = ?, mtime = ? WHERE id = ?');
try {
  upd.bind([filler.slice(0, 2047) + 'y', Date.now(), 42]);
  upd.stepReset();
} finally { upd.finalize(); }
db.exec('COMMIT');
const tVfs = performance.now() - t0;

const vfsBytes = stats.bytesWritten;
const vfsCalls = stats.writeCalls;
const vfsSyncs = stats.syncs;

// O caminho atual, para a MESMA mudanca: serializacao integral do banco.
const t1 = performance.now();
const exported = sqlite3.capi.sqlite3_js_db_export(db);
const tExport = performance.now() - t1;
const exportBytes = exported.byteLength;

console.log(`
--- uma transacao de 1 linha (equivalente a uma nota reindexada) ---
VFS node:fs   : ${fmt(vfsBytes)} bytes em ${vfsCalls} xWrite, ${vfsSyncs} fsync, ${tVfs.toFixed(1)} ms
export integral: ${fmt(exportBytes)} bytes em ${tExport.toFixed(1)} ms  (o caminho de hoje)
razao          : ${(exportBytes / vfsBytes).toFixed(0)}x menos bytes gravados pelo VFS`);

// ------------------------------------------------------------- integridade
const check1 = db.selectValue('PRAGMA integrity_check');
console.log(`\nintegrity_check (banco aberto): ${check1}`);
db.close();

// Reabre do disco: prova que o arquivo persistiu como banco valido.
const db2 = new sqlite3.oo1.DB(DB_FILE, 'w', 'nodefs');
const check2 = db2.selectValue('PRAGMA integrity_check');
const rows2 = db2.selectValue('SELECT COUNT(*) FROM notes');
const kept = db2.selectValue('SELECT substr(content, -1) FROM notes WHERE id = 42');
console.log(`integrity_check (reaberto)    : ${check2}`);
console.log(`linhas apos reabrir           : ${fmt(rows2)}`);
console.log(`update persistido (id=42)     : ${kept === 'y' ? 'sim' : 'NAO'}`);
db2.close();

console.log(`\narquivo final: ${DB_PATH} (${fmt(statSync(DB_PATH).size)} bytes)`);
console.log(`journal residual: ${existsSync(DB_PATH + '-journal') ? 'presente' : 'ausente'}`);

const ok = check1 === 'ok' && check2 === 'ok' && rows2 === rows && kept === 'y';
console.log(`\nACEITE E1: ${ok ? 'VERDE' : 'VERMELHO'}`);
process.exit(ok ? 0 : 1);
