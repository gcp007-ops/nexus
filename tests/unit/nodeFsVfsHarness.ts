/**
 * A test double for the two things `installNodeFsVfs` talks to: the sqlite3
 * WASM module and `node:fs`.
 *
 * Both are faked rather than stubbed, because the failures this suite exists to
 * describe are about state — a descriptor that outlives a failed open, bytes
 * that did or did not land at an offset, a counter that moved when nothing was
 * written. A `jest.fn()` that returns a number cannot answer any of those.
 *
 * The heap is a real `Uint8Array`, so `subarray` aliasing behaves the way it
 * does in the plugin: what `xRead` writes into its view is visible to the
 * caller, and a tail the VFS forgets to zero shows up as leftover bytes.
 */

import * as realPath from 'node:path';

/* ---------------------------------------------------------------- constants */

/**
 * Real values, not placeholders. The implementation reads these off `capi` by
 * name, so a test would pass with any number here — but a wrong one turns the
 * assertion into a tautology, and these are the codes a reader will compare
 * against the SQLite documentation.
 */
export const CAPI_CONSTANTS = {
  SQLITE_OK: 0,
  SQLITE_NOTFOUND: 12,
  SQLITE_CANTOPEN: 14,
  SQLITE_IOERR: 10,
  SQLITE_IOERR_READ: 266,
  SQLITE_IOERR_SHORT_READ: 522,
  SQLITE_IOERR_WRITE: 778,
  SQLITE_IOERR_FSYNC: 1034,
  SQLITE_IOERR_TRUNCATE: 1546,
  SQLITE_IOERR_FSTAT: 1802,
  SQLITE_IOERR_DELETE: 2570,
  SQLITE_IOERR_CLOSE: 4106,
  SQLITE_OPEN_READONLY: 0x00000001,
  SQLITE_OPEN_READWRITE: 0x00000002,
  SQLITE_OPEN_CREATE: 0x00000004,
  SQLITE_OPEN_DELETEONCLOSE: 0x00000008,
  SQLITE_OPEN_EXCLUSIVE: 0x00000010,
  SQLITE_LOCK_NONE: 0,
  SQLITE_LOCK_SHARED: 1,
  SQLITE_LOCK_RESERVED: 2,
  SQLITE_LOCK_EXCLUSIVE: 4
} as const;

/* -------------------------------------------------------------- fake node:fs */

export type FsOp =
  | 'openSync' | 'closeSync' | 'readSync' | 'writeSync'
  | 'ftruncateSync' | 'fsyncSync' | 'fstatSync' | 'unlinkSync' | 'existsSync';

export interface FakeDisk {
  /** Path -> contents. Absent means the file does not exist. */
  files: Map<string, Uint8Array>;
  /** Descriptors currently open. Emptied by `closeSync`. */
  openFds: Map<number, string>;
  /** Make the next call to an operation throw. Consumed on use. */
  failOnce(op: FsOp, error: Error): void;
  /** Make every call to an operation throw until cleared. */
  failAlways(op: FsOp, error: Error): void;
  clearFailures(): void;
  /** Force `writeSync` to report fewer bytes than it was handed. */
  shortWriteTo: number | null;
  fs: FakeFs;
}

export interface FakeFs {
  constants: { O_RDONLY: number; O_RDWR: number; O_CREAT: number; O_EXCL: number };
  openSync: jest.Mock;
  closeSync: jest.Mock;
  readSync: jest.Mock;
  writeSync: jest.Mock;
  ftruncateSync: jest.Mock;
  fsyncSync: jest.Mock;
  fstatSync: jest.Mock;
  unlinkSync: jest.Mock;
  existsSync: jest.Mock;
}

export function enospc(): Error {
  const error = new Error('ENOSPC: no space left on device, write') as Error & { code: string };
  error.code = 'ENOSPC';
  return error;
}

export function eio(what: string): Error {
  const error = new Error(`EIO: i/o error, ${what}`) as Error & { code: string };
  error.code = 'EIO';
  return error;
}

export function createFakeDisk(): FakeDisk {
  const files = new Map<string, Uint8Array>();
  const openFds = new Map<number, string>();
  const once = new Map<FsOp, Error>();
  const always = new Map<FsOp, Error>();
  let nextFd = 3;

  const guard = (op: FsOp): void => {
    const single = once.get(op);
    if (single) {
      once.delete(op);
      throw single;
    }
    const persistent = always.get(op);
    if (persistent) throw persistent;
  };

  const pathOf = (fd: number): string => {
    const target = openFds.get(fd);
    if (target === undefined) {
      const error = new Error('EBADF: bad file descriptor') as Error & { code: string };
      error.code = 'EBADF';
      throw error;
    }
    return target;
  };

  const disk: FakeDisk = {
    files,
    openFds,
    shortWriteTo: null,
    failOnce(op, error) { once.set(op, error); },
    failAlways(op, error) { always.set(op, error); },
    clearFailures() { once.clear(); always.clear(); },
    fs: {
      constants: { O_RDONLY: 0, O_RDWR: 2, O_CREAT: 512, O_EXCL: 2048 },

      openSync: jest.fn((target: string, flags: number) => {
        guard('openSync');
        if (!files.has(target)) {
          if (!(flags & 512)) {
            const error = new Error(`ENOENT: no such file, open '${target}'`) as Error & { code: string };
            error.code = 'ENOENT';
            throw error;
          }
          files.set(target, new Uint8Array(0));
        } else if (flags & 2048) {
          const error = new Error(`EEXIST: file already exists, open '${target}'`) as Error & { code: string };
          error.code = 'EEXIST';
          throw error;
        }
        const fd = nextFd++;
        openFds.set(fd, target);
        return fd;
      }),

      closeSync: jest.fn((fd: number) => {
        guard('closeSync');
        pathOf(fd);
        openFds.delete(fd);
      }),

      readSync: jest.fn((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
        guard('readSync');
        const data = files.get(pathOf(fd)) ?? new Uint8Array(0);
        const available = Math.max(0, Math.min(length, data.length - position));
        buffer.set(data.subarray(position, position + available), offset);
        return available;
      }),

      writeSync: jest.fn((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
        guard('writeSync');
        const target = pathOf(fd);
        const accepted = disk.shortWriteTo === null ? length : Math.min(length, disk.shortWriteTo);
        let data = files.get(target) ?? new Uint8Array(0);
        if (position + accepted > data.length) {
          const grown = new Uint8Array(position + accepted);
          grown.set(data);
          data = grown;
          files.set(target, data);
        }
        data.set(buffer.subarray(offset, offset + accepted), position);
        return accepted;
      }),

      ftruncateSync: jest.fn((fd: number, size: number) => {
        guard('ftruncateSync');
        const target = pathOf(fd);
        const data = files.get(target) ?? new Uint8Array(0);
        const resized = new Uint8Array(size);
        resized.set(data.subarray(0, Math.min(size, data.length)));
        files.set(target, resized);
      }),

      fsyncSync: jest.fn((fd: number) => {
        guard('fsyncSync');
        pathOf(fd);
      }),

      fstatSync: jest.fn((fd: number) => {
        guard('fstatSync');
        return { size: (files.get(pathOf(fd)) ?? new Uint8Array(0)).length };
      }),

      unlinkSync: jest.fn((target: string) => {
        guard('unlinkSync');
        if (!files.delete(target)) {
          const error = new Error(`ENOENT: no such file, unlink '${target}'`) as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
      }),

      existsSync: jest.fn((target: string) => {
        guard('existsSync');
        return files.has(target);
      })
    }
  };

  return disk;
}

/* ------------------------------------------------------------ fake wasm heap */

const HEAP_BYTES = 1 << 16;

export interface FakeWasm {
  heap: Uint8Array;
  /** Bump-allocate `bytes` and return the pointer. */
  alloc(bytes: number): number;
  /** Write a NUL-terminated string and return the pointer. */
  allocCString(value: string): number;
  read32(pointer: number): number;
  readF64(pointer: number): number;
  readI64(pointer: number): bigint;
  /** Scopes pushed minus scopes popped; must be zero after every call. */
  openScopes(): number;
  api: Record<string, unknown>;
}

export function createFakeWasm(): FakeWasm {
  const heap = new Uint8Array(HEAP_BYTES);
  const view = new DataView(heap.buffer);
  // Pointer 0 is null in C; start past it so a forgotten allocation is not
  // mistaken for a valid address.
  let bump = 16;
  let scopes = 0;

  const alloc = (bytes: number): number => {
    const pointer = bump;
    bump += bytes + (8 - (bytes % 8));
    if (bump >= HEAP_BYTES) throw new Error('fake heap exhausted');
    return pointer;
  };

  const allocCString = (value: string): number => {
    const encoded = new TextEncoder().encode(value);
    const pointer = alloc(encoded.length + 1);
    heap.set(encoded, pointer);
    heap[pointer + encoded.length] = 0;
    return pointer;
  };

  const cstrToJs = (pointer: number): string => {
    let end = pointer;
    while (end < HEAP_BYTES && heap[end] !== 0) end++;
    return new TextDecoder().decode(heap.subarray(pointer, end));
  };

  return {
    heap,
    alloc,
    allocCString,
    read32: (pointer) => view.getUint32(pointer, true),
    readF64: (pointer) => view.getFloat64(pointer, true),
    readI64: (pointer) => view.getBigInt64(pointer, true),
    openScopes: () => scopes,
    api: {
      heap8u: () => heap,
      peek8: (pointer: number) => heap[pointer],
      poke32: (pointer: number, value: number) => view.setUint32(pointer, value, true),
      poke: (pointer: number, value: unknown, type: string) => {
        if (type === 'i64') view.setBigInt64(pointer, BigInt(value as bigint), true);
        else if (type === 'double') view.setFloat64(pointer, Number(value), true);
        else throw new Error(`fake wasm: unsupported poke type ${type}`);
      },
      cstrToJs,
      allocCString,
      cstrncpy: (dest: number, src: number, n: number) => {
        let i = 0;
        while (i < n && heap[src + i] !== 0) { heap[dest + i] = heap[src + i]; i++; }
        if (i < n) heap[dest + i] = 0;
        return i;
      },
      scopedAllocPush: () => { scopes++; return { id: scopes }; },
      scopedAllocPop: () => { scopes--; },
      scopedAllocCString: (value: string, _returnLength: true) => {
        const encoded = new TextEncoder().encode(value);
        return [allocCString(value), encoded.length] as [number, number];
      }
    }
  };
}

/* ---------------------------------------------------------- fake sqlite3 capi */

export interface FakeStruct {
  pointer: number;
  dispose: jest.Mock;
  addOnDispose: jest.Mock;
  [field: string]: unknown;
}

export interface CapturedVfs {
  io?: { struct: FakeStruct; methods: Record<string, (...args: never[]) => number> };
  vfs?: { struct: FakeStruct; methods: Record<string, (...args: never[]) => number>; asDefault?: boolean };
}

export interface FakeSqlite3 {
  module: unknown;
  wasm: FakeWasm;
  captured: CapturedVfs;
  /** Names `sqlite3_vfs_find` should report as already taken. */
  registered: Set<string>;
  /** Pointer `sqlite3_vfs_find(null)` returns; 0 means "no default VFS". */
  defaultVfsPointer: number;
  /** Fields a `sqlite3_vfs` built over `defaultVfsPointer` exposes. */
  defaultVfsFields: Record<string, unknown>;
  /** Make the next `new sqlite3_file(...)` throw, to exercise a partial open. */
  failNextFileStruct: Error | null;
  structs: FakeStruct[];
}

export function createFakeSqlite3(): FakeSqlite3 {
  const wasm = createFakeWasm();
  const captured: CapturedVfs = {};
  const structs: FakeStruct[] = [];

  const state = {
    registered: new Set<string>(),
    defaultVfsPointer: 0,
    defaultVfsFields: {} as Record<string, unknown>,
    failNextFileStruct: null as Error | null
  };

  const makeStruct = (seed: Record<string, unknown> = {}): FakeStruct => {
    const struct: FakeStruct = {
      pointer: wasm.alloc(64),
      dispose: jest.fn(),
      addOnDispose: jest.fn(),
      ...seed
    };
    structs.push(struct);
    return struct;
  };

  function Sqlite3Vfs(this: FakeStruct, pointer?: number) {
    const seed = pointer !== undefined && pointer === state.defaultVfsPointer
      ? state.defaultVfsFields
      : {};
    return makeStruct(seed);
  }

  function Sqlite3IoMethods(this: FakeStruct) {
    return makeStruct();
  }

  function Sqlite3File(this: FakeStruct, pointer?: number) {
    if (state.failNextFileStruct) {
      const error = state.failNextFileStruct;
      state.failNextFileStruct = null;
      throw error;
    }
    return makeStruct({ forPointer: pointer });
  }
  (Sqlite3File as unknown as { structInfo: { sizeof: number } }).structInfo = { sizeof: 96 };

  const capi = {
    ...CAPI_CONSTANTS,
    sqlite3_vfs: Sqlite3Vfs,
    sqlite3_io_methods: Sqlite3IoMethods,
    sqlite3_file: Sqlite3File,
    sqlite3_vfs_find: (name: string | null) =>
      name === null ? state.defaultVfsPointer : (state.registered.has(name) ? 1 : 0)
  };

  const module = {
    capi,
    wasm: wasm.api,
    vfs: {
      installVfs: (options: CapturedVfs) => {
        if (options.io) captured.io = options.io;
        if (options.vfs) captured.vfs = options.vfs;
        return options;
      }
    }
  };

  return {
    module,
    wasm,
    captured,
    structs,
    get registered() { return state.registered; },
    get defaultVfsPointer() { return state.defaultVfsPointer; },
    set defaultVfsPointer(value: number) { state.defaultVfsPointer = value; },
    get defaultVfsFields() { return state.defaultVfsFields; },
    set defaultVfsFields(value: Record<string, unknown>) { state.defaultVfsFields = value; },
    get failNextFileStruct() { return state.failNextFileStruct; },
    set failNextFileStruct(value: Error | null) { state.failNextFileStruct = value; }
  } as FakeSqlite3;
}

export const fakePath = realPath.posix;
