import './env-shim.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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

const capi = sqlite3.capi;
console.log('version:', capi.sqlite3_libversion());
console.log('has vfs.installVfs:', typeof sqlite3.vfs?.installVfs);
console.log('has capi.sqlite3_vfs:', typeof capi.sqlite3_vfs);
console.log('has capi.sqlite3_io_methods:', typeof capi.sqlite3_io_methods);
console.log('has capi.sqlite3_file:', typeof capi.sqlite3_file);
console.log('sqlite3_file sizeof:', capi.sqlite3_file?.structInfo?.sizeof);
const pD = capi.sqlite3_vfs_find(null);
console.log('default vfs ptr:', pD);
if (pD) {
  const d = new capi.sqlite3_vfs(pD);
  console.log('default vfs name:', sqlite3.wasm.cstrToJs(d.$zName));
  console.log('has xRandomness:', d.$xRandomness, 'xSleep:', d.$xSleep);
  d.dispose();
}
console.log('io_methods members:', Object.keys(capi.sqlite3_io_methods.structInfo.members).join(','));
console.log('vfs members:', Object.keys(capi.sqlite3_vfs.structInfo.members).join(','));
