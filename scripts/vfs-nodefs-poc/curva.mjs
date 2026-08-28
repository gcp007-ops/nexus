// Curva: bytes gravados por transacao em funcao do numero de notas alteradas.
// Responde onde (se em algum ponto) o export integral deixa de ser pior.
import './env-shim.mjs';
import { readFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { installNodeFsVfs } from './nodefs-vfs.mjs';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@dao-xyz/sqlite3-vec/sqlite3.wasm');
const { default: sqlite3InitModule } = await import(wasmPath.replace(/sqlite3\.wasm$/, 'sqlite3.mjs'));
const wasmBinary = readFileSync(wasmPath);
const sqlite3 = await sqlite3InitModule({
  instantiateWasm: (i, cb) => { WebAssembly.instantiate(wasmBinary, i).then(r => cb(r.instance)); return {}; },
  print: () => {}, printErr: (m) => console.error('[SQLite]', m)
});

const ROOT = path.join(process.cwd(), '.poc-curva');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const { stats } = installNodeFsVfs(sqlite3, { vfsName: 'nodefs', root: ROOT });

const DB_FILE = 'curva.db';
const DB_PATH = path.join(ROOT, DB_FILE);
const db = new sqlite3.oo1.DB(DB_FILE, 'c', 'nodefs');
db.exec(`
  PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=NORMAL; PRAGMA page_size=4096;
  CREATE TABLE notes (id INTEGER PRIMARY KEY, path TEXT, content TEXT, mtime INTEGER);
  CREATE INDEX idx_notes_path ON notes(path);
`);
const filler = 'x'.repeat(2048);
let id = 0;
db.exec('BEGIN');
while (statSync(DB_PATH).size < 90 * 1024 * 1024) {
  const st = db.prepare('INSERT INTO notes (id,path,content,mtime) VALUES (?,?,?,?)');
  try { for (let i = 0; i < 2000; i++) { st.bind([++id, `Producao/nota-${id}.md`, filler, Date.now()]); st.stepReset(); } }
  finally { st.finalize(); }
  db.exec('COMMIT; BEGIN');
}
db.exec('COMMIT');

const dbBytes = statSync(DB_PATH).size;
const total = db.selectValue('SELECT COUNT(*) FROM notes');
const fmt = (n) => Math.round(n).toLocaleString('pt-BR');
console.log(`banco: ${fmt(total)} linhas, ${fmt(dbBytes)} bytes, page_size 4096\n`);
console.log('notas alteradas | bytes VFS  | xWrite | export integral | razao');
console.log('----------------|------------|--------|-----------------|-------');

for (const n of [1, 10, 100, 1000, 5000, 24000]) {
  if (n > total) continue;
  stats.reset();
  db.exec('BEGIN');
  const st = db.prepare('UPDATE notes SET content=?, mtime=? WHERE id=?');
  try {
    for (let i = 1; i <= n; i++) { st.bind([filler.slice(0, 2040) + String(i).padStart(8, '0'), Date.now(), i]); st.stepReset(); }
  } finally { st.finalize(); }
  db.exec('COMMIT');
  const b = stats.bytesWritten;
  console.log(
    `${String(n).padStart(15)} | ${String(fmt(b)).padStart(10)} | ${String(stats.writeCalls).padStart(6)} | ${String(fmt(dbBytes)).padStart(15)} | ${(dbBytes / b).toFixed(1)}x`
  );
}
console.log(`\nintegrity_check: ${db.selectValue('PRAGMA integrity_check')}`);
db.close();
