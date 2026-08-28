/**
 * VFS minimo do SQLite/WASM sobre node:fs, montado por sqlite3.vfs.installVfs.
 *
 * E1 da NexusVfsNodeFs-INI — prova de conceito. Escopo deliberadamente estreito:
 * single-process, sem WAL (sem xShm*), locking no-op. O objetivo e responder uma
 * pergunta: paginas escritas por transacao, em vez do export integral do banco.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SECTOR_SIZE = 4096;

export function installNodeFsVfs(sqlite3, opts = {}) {
  const { vfsName = 'nodefs', asDefault = false, root = process.cwd() } = opts;
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;

  if (capi.sqlite3_vfs_find(vfsName)) {
    throw new Error(`VFS ja registrado: ${vfsName}`);
  }

  /** pFile (ponteiro WASM) -> { fd, path, flags } */
  const openFiles = new Map();

  /** Contadores de I/O — a medicao do E1. */
  const stats = {
    writeCalls: 0, bytesWritten: 0,
    readCalls: 0, bytesRead: 0,
    syncs: 0, opens: 0, truncates: 0, deletes: 0,
    reset() {
      this.writeCalls = this.bytesWritten = 0;
      this.readCalls = this.bytesRead = 0;
      this.syncs = this.opens = this.truncates = this.deletes = 0;
    }
  };

  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(root, p));

  const ioMethods = {
    xClose(pFile) {
      const f = openFiles.get(pFile);
      if (!f) return 0;
      try {
        fs.closeSync(f.fd);
        openFiles.delete(pFile);
        if (f.flags & capi.SQLITE_OPEN_DELETEONCLOSE) {
          try { fs.unlinkSync(f.path); } catch { /* ja removido */ }
        }
        return 0;
      } catch { return capi.SQLITE_IOERR_CLOSE; }
    },

    xRead(pFile, pDest, n, offset64) {
      const f = openFiles.get(pFile);
      if (!f) return capi.SQLITE_IOERR_READ;
      try {
        const view = wasm.heap8u().subarray(pDest, pDest + n);
        const got = fs.readSync(f.fd, view, 0, n, Number(offset64));
        stats.readCalls++; stats.bytesRead += got;
        if (got < n) {
          wasm.heap8u().fill(0, pDest + got, pDest + n);
          return capi.SQLITE_IOERR_SHORT_READ;
        }
        return 0;
      } catch { return capi.SQLITE_IOERR_READ; }
    },

    xWrite(pFile, pSrc, n, offset64) {
      const f = openFiles.get(pFile);
      if (!f) return capi.SQLITE_IOERR_WRITE;
      try {
        const view = wasm.heap8u().subarray(pSrc, pSrc + n);
        const put = fs.writeSync(f.fd, view, 0, n, Number(offset64));
        stats.writeCalls++; stats.bytesWritten += put;
        return put === n ? 0 : capi.SQLITE_IOERR_WRITE;
      } catch { return capi.SQLITE_IOERR_WRITE; }
    },

    xTruncate(pFile, sz64) {
      const f = openFiles.get(pFile);
      if (!f) return capi.SQLITE_IOERR_TRUNCATE;
      try {
        fs.ftruncateSync(f.fd, Number(sz64));
        stats.truncates++;
        return 0;
      } catch { return capi.SQLITE_IOERR_TRUNCATE; }
    },

    xSync(pFile /*, flags */) {
      const f = openFiles.get(pFile);
      if (!f) return capi.SQLITE_IOERR_FSYNC;
      try {
        fs.fsyncSync(f.fd);
        stats.syncs++;
        return 0;
      } catch { return capi.SQLITE_IOERR_FSYNC; }
    },

    xFileSize(pFile, pSz64) {
      const f = openFiles.get(pFile);
      if (!f) return capi.SQLITE_IOERR_FSTAT;
      try {
        wasm.poke(pSz64, BigInt(fs.fstatSync(f.fd).size), 'i64');
        return 0;
      } catch { return capi.SQLITE_IOERR_FSTAT; }
    },

    // Single-process: o locking e no-op declarado, nao esquecido.
    xLock(pFile, lockType) {
      const f = openFiles.get(pFile);
      if (f) f.lockType = lockType;
      return 0;
    },
    xUnlock(pFile, lockType) {
      const f = openFiles.get(pFile);
      if (f) f.lockType = lockType;
      return 0;
    },
    xCheckReservedLock(pFile, pOut) {
      wasm.poke32(pOut, 0);
      return 0;
    },
    xFileControl() { return capi.SQLITE_NOTFOUND; },
    xSectorSize() { return SECTOR_SIZE; },
    xDeviceCharacteristics() { return 0; }
  };

  const nodeFsIoMethods = new capi.sqlite3_io_methods();
  nodeFsIoMethods.$iVersion = 1;
  sqlite3.vfs.installVfs({ io: { struct: nodeFsIoMethods, methods: ioMethods } });

  const vfsMethods = {
    xOpen(pVfs, zName, pFile, flags, pOutFlags) {
      try {
        const name = zName && wasm.peek8(zName)
          ? resolve(wasm.cstrToJs(zName))
          : path.join(root, `sqlite-tmp-${Math.random().toString(36).slice(2)}`);

        let osFlags;
        if (flags & capi.SQLITE_OPEN_READONLY) {
          osFlags = fs.constants.O_RDONLY;
        } else {
          osFlags = fs.constants.O_RDWR;
          if (flags & capi.SQLITE_OPEN_CREATE) osFlags |= fs.constants.O_CREAT;
          if (flags & capi.SQLITE_OPEN_EXCLUSIVE) osFlags |= fs.constants.O_EXCL;
        }

        const fd = fs.openSync(name, osFlags, 0o644);
        openFiles.set(pFile, { fd, path: name, flags, lockType: capi.SQLITE_LOCK_NONE });
        stats.opens++;

        const sq3File = new capi.sqlite3_file(pFile);
        sq3File.$pMethods = nodeFsIoMethods.pointer;
        sq3File.dispose();

        if (pOutFlags) wasm.poke32(pOutFlags, flags);
        return 0;
      } catch {
        return capi.SQLITE_CANTOPEN;
      }
    },

    xDelete(pVfs, zName /*, doSyncDir */) {
      try {
        const p = resolve(wasm.cstrToJs(zName));
        if (fs.existsSync(p)) { fs.unlinkSync(p); stats.deletes++; }
        return 0;
      } catch { return capi.SQLITE_IOERR_DELETE; }
    },

    xAccess(pVfs, zName, flags, pOut) {
      try {
        const p = resolve(wasm.cstrToJs(zName));
        wasm.poke32(pOut, fs.existsSync(p) ? 1 : 0);
      } catch {
        wasm.poke32(pOut, 0);
      }
      return 0;
    },

    xFullPathname(pVfs, zName, nOut, pOut) {
      const full = resolve(wasm.cstrToJs(zName));
      const scope = wasm.scopedAllocPush();
      try {
        const [cStr, n] = wasm.scopedAllocCString(full, true);
        if (n > nOut) return capi.SQLITE_CANTOPEN;
        wasm.cstrncpy(pOut, cStr, nOut);
        return 0;
      } finally {
        wasm.scopedAllocPop(scope);
      }
    },

    xGetLastError(pVfs, nOut, pOut) { return 0; },

    xCurrentTime(pVfs, pOut) {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double');
      return 0;
    },
    xCurrentTimeInt64(pVfs, pOut) {
      wasm.poke(pOut, BigInt(Math.round(2440587.5 * 86400000)) + BigInt(Date.now()), 'i64');
      return 0;
    }
  };

  const nodeFsVfs = new capi.sqlite3_vfs();
  nodeFsVfs.$iVersion = 2;
  nodeFsVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  nodeFsVfs.$mxPathname = 1024;
  nodeFsVfs.addOnDispose(nodeFsVfs.$zName = wasm.allocCString(vfsName));

  // Herda xRandomness/xSleep do VFS default quando ele existe (unix-none, neste build).
  const pDefault = capi.sqlite3_vfs_find(null);
  if (pDefault) {
    const dflt = new capi.sqlite3_vfs(pDefault);
    nodeFsVfs.$xRandomness = dflt.$xRandomness;
    nodeFsVfs.$xSleep = dflt.$xSleep;
    dflt.dispose();
  }
  if (!nodeFsVfs.$xRandomness) {
    vfsMethods.xRandomness = (pVfs, nOut, pOut) => {
      const heap = wasm.heap8u();
      for (let i = 0; i < nOut; ++i) heap[pOut + i] = (Math.random() * 255000) & 0xff;
      return nOut;
    };
  }
  if (!nodeFsVfs.$xSleep) vfsMethods.xSleep = () => 0;

  sqlite3.vfs.installVfs({
    vfs: { struct: nodeFsVfs, methods: vfsMethods, asDefault }
  });

  return { vfsName, stats, openFiles, struct: nodeFsVfs };
}
