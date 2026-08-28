/**
 * A SQLite VFS backed by node:fs, mounted through sqlite3.vfs.installVfs.
 *
 * Why this exists: the cache is a WASM SQLite database held in memory, and it
 * was persisted by serialising the whole thing — `sqlite3_js_db_export()` — into
 * a new blob on every autosave. One reindexed note cost the entire database.
 * Measured in this vault on 2026-08-27: 96,785,297 bytes written against 26,598
 * bytes of growth in 601 s. A VFS makes SQLite write the pages it actually
 * changed, which is the difference between spacing the writes out and not making
 * them.
 *
 * The OPFS VFS that ships with the build cannot be used here:
 * `createSyncAccessHandle` does not exist on the renderer's main thread, and
 * moving SQLite to a Worker would make 197 synchronous call sites asynchronous.
 * `installVfs` is the same public API the OPFS pool uses, so this is the
 * extension the build provides for, not a workaround around it.
 *
 * Deliberate limits, all of them declared rather than forgotten:
 * - single process. Locking is a no-op, which is sound for one Obsidian window
 *   against its own cache and is NOT sound for anything else;
 * - no WAL. There is no `xShm*` here; `journal_mode=MEMORY` with
 *   `synchronous=NORMAL` reduces a commit to one write per changed page, at
 *   the cost of crash durability. See `VfsPersistenceService` for the trade;
 * - `node:fs` and `node:path` are resolved at call time through
 *   `desktopRequire`. A top-level import would be executed during module init,
 *   before any platform check, and would take the plugin down at launch on every
 *   phone. See scripts/check-mobile-imports.mjs.
 */

import { desktopRequire } from '../../../utils/desktopRequire';

const SECTOR_SIZE = 4096;

/** Counters read straight out of xWrite/xRead, so measurements are not estimates. */
export interface NodeFsVfsStats {
  writeCalls: number;
  bytesWritten: number;
  readCalls: number;
  bytesRead: number;
  syncs: number;
  opens: number;
  truncates: number;
  deletes: number;
  reset(): void;
}

export interface InstalledNodeFsVfs {
  vfsName: string;
  stats: NodeFsVfsStats;
  openFileCount(): number;
}

export interface NodeFsVfsOptions {
  /** Name the VFS registers under, passed to `new oo1.DB(path, flags, vfsName)`. */
  vfsName?: string;
  /** Whether SQLite should use it for databases opened without a VFS name. */
  asDefault?: boolean;
  /** Base directory for relative paths handed to the VFS. */
  root: string;
}

/**
 * The slice of the sqlite3 WASM module a VFS needs.
 *
 * The struct binding layer is genuinely dynamic — `$`-prefixed fields are
 * generated from the C struct at load time — so it is described here loosely on
 * purpose rather than mis-described precisely.
 */
type WasmStruct = Record<string, unknown> & {
  pointer: number;
  dispose(): void;
  addOnDispose(value: unknown): void;
};

interface StructConstructor {
  new(pointer?: number): WasmStruct;
  structInfo: { sizeof: number };
}

export interface SQLiteVfsCapableModule {
  capi: Record<string, number> & {
    sqlite3_vfs: StructConstructor;
    sqlite3_io_methods: StructConstructor;
    sqlite3_file: StructConstructor;
    sqlite3_vfs_find(name: string | null): number;
  };
  wasm: {
    heap8u(): Uint8Array;
    peek8(pointer: number): number;
    poke(pointer: number, value: unknown, type: string): void;
    poke32(pointer: number, value: number): void;
    cstrToJs(pointer: number): string;
    cstrncpy(dest: number, src: number, n: number): number;
    allocCString(value: string): number;
    scopedAllocPush(): unknown;
    scopedAllocPop(scope: unknown): void;
    scopedAllocCString(value: string, returnLength: true): [number, number];
  };
  vfs: {
    installVfs(options: unknown): unknown;
  };
}

interface OpenFile {
  fd: number;
  path: string;
  flags: number;
  lockType: number;
}

/**
 * Register the VFS on a sqlite3 module.
 *
 * Throws rather than returning a failure value: every caller has to fall back to
 * the blob store when this does not work, and an exception is the one shape a
 * caller cannot accidentally ignore. Callers are expected to catch.
 */
export function installNodeFsVfs(
  sqlite3: SQLiteVfsCapableModule,
  options: NodeFsVfsOptions
): InstalledNodeFsVfs {
  const { vfsName = 'nodefs', asDefault = false, root } = options;
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;

  const fs = desktopRequire<typeof import('node:fs')>('node:fs');
  const path = desktopRequire<typeof import('node:path')>('node:path');

  if (capi.sqlite3_vfs_find(vfsName)) {
    throw new Error(`[NodeFsVfs] A VFS named "${vfsName}" is already registered.`);
  }

  /** pFile (a WASM pointer) -> the descriptor behind it. */
  const openFiles = new Map<number, OpenFile>();

  const stats: NodeFsVfsStats = {
    writeCalls: 0, bytesWritten: 0,
    readCalls: 0, bytesRead: 0,
    syncs: 0, opens: 0, truncates: 0, deletes: 0,
    reset() {
      this.writeCalls = this.bytesWritten = 0;
      this.readCalls = this.bytesRead = 0;
      this.syncs = this.opens = this.truncates = this.deletes = 0;
    }
  };

  const resolve = (candidate: string): string =>
    path.isAbsolute(candidate) ? candidate : path.join(root, candidate);

  const ioMethods = {
    xClose(pFile: number): number {
      const file = openFiles.get(pFile);
      if (!file) return 0;
      try {
        fs.closeSync(file.fd);
        openFiles.delete(pFile);
        if (file.flags & capi.SQLITE_OPEN_DELETEONCLOSE) {
          try { fs.unlinkSync(file.path); } catch { /* already gone */ }
        }
        return 0;
      } catch { return capi.SQLITE_IOERR_CLOSE; }
    },

    xRead(pFile: number, pDest: number, n: number, offset64: bigint | number): number {
      const file = openFiles.get(pFile);
      if (!file) return capi.SQLITE_IOERR_READ;
      try {
        const view = wasm.heap8u().subarray(pDest, pDest + n);
        const got = fs.readSync(file.fd, view, 0, n, Number(offset64));
        stats.readCalls++; stats.bytesRead += got;
        if (got < n) {
          // SQLite requires the unread tail zeroed, not left as whatever the
          // heap held.
          wasm.heap8u().fill(0, pDest + got, pDest + n);
          return capi.SQLITE_IOERR_SHORT_READ;
        }
        return 0;
      } catch { return capi.SQLITE_IOERR_READ; }
    },

    xWrite(pFile: number, pSrc: number, n: number, offset64: bigint | number): number {
      const file = openFiles.get(pFile);
      if (!file) return capi.SQLITE_IOERR_WRITE;
      try {
        const view = wasm.heap8u().subarray(pSrc, pSrc + n);
        const put = fs.writeSync(file.fd, view, 0, n, Number(offset64));
        stats.writeCalls++; stats.bytesWritten += put;
        return put === n ? 0 : capi.SQLITE_IOERR_WRITE;
      } catch { return capi.SQLITE_IOERR_WRITE; }
    },

    xTruncate(pFile: number, size64: bigint | number): number {
      const file = openFiles.get(pFile);
      if (!file) return capi.SQLITE_IOERR_TRUNCATE;
      try {
        fs.ftruncateSync(file.fd, Number(size64));
        stats.truncates++;
        return 0;
      } catch { return capi.SQLITE_IOERR_TRUNCATE; }
    },

    xSync(pFile: number): number {
      const file = openFiles.get(pFile);
      if (!file) return capi.SQLITE_IOERR_FSYNC;
      try {
        fs.fsyncSync(file.fd);
        stats.syncs++;
        return 0;
      } catch { return capi.SQLITE_IOERR_FSYNC; }
    },

    xFileSize(pFile: number, pSize64: number): number {
      const file = openFiles.get(pFile);
      if (!file) return capi.SQLITE_IOERR_FSTAT;
      try {
        wasm.poke(pSize64, BigInt(fs.fstatSync(file.fd).size), 'i64');
        return 0;
      } catch { return capi.SQLITE_IOERR_FSTAT; }
    },

    // Single process: the locking is a declared no-op, not an oversight. It
    // records the level SQLite asked for and agrees, which is correct while one
    // process owns the file and wrong the moment two do.
    xLock(pFile: number, lockType: number): number {
      const file = openFiles.get(pFile);
      if (file) file.lockType = lockType;
      return 0;
    },
    xUnlock(pFile: number, lockType: number): number {
      const file = openFiles.get(pFile);
      if (file) file.lockType = lockType;
      return 0;
    },
    xCheckReservedLock(pFile: number, pOut: number): number {
      wasm.poke32(pOut, 0);
      return 0;
    },
    xFileControl(): number { return capi.SQLITE_NOTFOUND; },
    xSectorSize(): number { return SECTOR_SIZE; },
    xDeviceCharacteristics(): number { return 0; }
  };

  const nodeFsIoMethods = new capi.sqlite3_io_methods();
  nodeFsIoMethods.$iVersion = 1;
  sqlite3.vfs.installVfs({ io: { struct: nodeFsIoMethods, methods: ioMethods } });

  const vfsMethods: Record<string, (...args: never[]) => number> = {
    xOpen(pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number): number {
      try {
        const name = zName && wasm.peek8(zName)
          ? resolve(wasm.cstrToJs(zName))
          : path.join(root, `sqlite-tmp-${Date.now().toString(36)}-${openFiles.size}`);

        let osFlags: number;
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

    xDelete(pVfs: number, zName: number): number {
      try {
        const target = resolve(wasm.cstrToJs(zName));
        if (fs.existsSync(target)) { fs.unlinkSync(target); stats.deletes++; }
        return 0;
      } catch { return capi.SQLITE_IOERR_DELETE; }
    },

    xAccess(pVfs: number, zName: number, flags: number, pOut: number): number {
      try {
        wasm.poke32(pOut, fs.existsSync(resolve(wasm.cstrToJs(zName))) ? 1 : 0);
      } catch {
        wasm.poke32(pOut, 0);
      }
      return 0;
    },

    xFullPathname(pVfs: number, zName: number, nOut: number, pOut: number): number {
      const full = resolve(wasm.cstrToJs(zName));
      const scope = wasm.scopedAllocPush();
      try {
        const [cStr, length] = wasm.scopedAllocCString(full, true);
        if (length > nOut) return capi.SQLITE_CANTOPEN;
        wasm.cstrncpy(pOut, cStr, nOut);
        return 0;
      } finally {
        wasm.scopedAllocPop(scope);
      }
    },

    xGetLastError(): number { return 0; },

    xCurrentTime(pVfs: number, pOut: number): number {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double');
      return 0;
    },
    xCurrentTimeInt64(pVfs: number, pOut: number): number {
      wasm.poke(pOut, BigInt(Math.round(2440587.5 * 86400000)) + BigInt(Date.now()), 'i64');
      return 0;
    }
  };

  const nodeFsVfs = new capi.sqlite3_vfs();
  nodeFsVfs.$iVersion = 2;
  nodeFsVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  nodeFsVfs.$mxPathname = 1024;
  nodeFsVfs.addOnDispose(nodeFsVfs.$zName = wasm.allocCString(vfsName));

  // Inherit xRandomness/xSleep from the default VFS when there is one. This
  // build reports "unix-none" for `sqlite3_vfs_find(null)`, and the OPFS pool
  // inherits the same two pointers the same way — so this is the documented
  // path, not a shortcut.
  const pDefault = capi.sqlite3_vfs_find(null);
  if (pDefault) {
    const fallback = new capi.sqlite3_vfs(pDefault);
    nodeFsVfs.$xRandomness = fallback.$xRandomness;
    nodeFsVfs.$xSleep = fallback.$xSleep;
    fallback.dispose();
  }
  if (!nodeFsVfs.$xRandomness) {
    vfsMethods.xRandomness = (pVfs: number, nOut: number, pOut: number): number => {
      const heap = wasm.heap8u();
      for (let i = 0; i < nOut; ++i) heap[pOut + i] = (Math.random() * 255000) & 0xff;
      return nOut;
    };
  }
  if (!nodeFsVfs.$xSleep) {
    vfsMethods.xSleep = () => 0;
  }

  sqlite3.vfs.installVfs({
    vfs: { struct: nodeFsVfs, methods: vfsMethods, asDefault }
  });

  return { vfsName, stats, openFileCount: () => openFiles.size };
}
