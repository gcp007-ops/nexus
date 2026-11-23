jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  SQLiteWasmBridge,
  PLANNING_CLONE_HEADROOM_BYTES,
  deserializeSlackBytes,
  isDiskFull
} from '../../src/database/storage/SQLiteWasmBridge';
import type { SQLiteWasmModule, SQLiteDatabaseHandle } from '../../src/database/storage/SQLiteWasmBridge';

const NOCOPY = 1;
const SIZE_LIMIT = 36;

/**
 * A fake sqlite3 module over a real byte heap: alloc is a bump allocator, and
 * sqlite3_serialize(NOCOPY) hands back the buffer a database was deserialized
 * from, the way memdb does, or 0 for a database that was never deserialized.
 */
function fakeModule(heapBytes = 4096) {
  const heap = new Uint8Array(heapBytes);
  let next = 8;
  const buffers = new Map<object, { ptr: number; size: number; capacity: number }>();
  const limits = new Map<object, bigint>();
  const allocs: number[] = [];
  const module = {
    oo1: { DB: jest.fn().mockImplementation(() => ({ exec: jest.fn(), prepare: jest.fn(), close: jest.fn(), changes: jest.fn(), selectValue: jest.fn() })) },
    wasm: {
      allocFromTypedArray: jest.fn(),
      alloc: jest.fn((n: number) => { allocs.push(n); if (next + n > heap.byteLength) throw new Error('Failed to allocate'); const p = next; next += n; return p; }),
      dealloc: jest.fn(),
      heap8u: () => heap,
      peek64: (p: number) => new DataView(heap.buffer).getBigInt64(p, true),
      poke64: (p: number, v: bigint) => new DataView(heap.buffer).setBigInt64(p, v, true)
    },
    capi: {
      SQLITE_DESERIALIZE_FREEONCLOSE: 1,
      SQLITE_DESERIALIZE_RESIZEABLE: 2,
      SQLITE_SERIALIZE_NOCOPY: NOCOPY,
      SQLITE_FCNTL_SIZE_LIMIT: SIZE_LIMIT,
      sqlite3_deserialize: jest.fn((db: object, _s: string, ptr: number, size: number, capacity: number) => { buffers.set(db, { ptr, size, capacity }); return 0; }),
      sqlite3_serialize: jest.fn((db: object, _s: string, sizePtr: number, flags: number) => {
        const b = buffers.get(db);
        new DataView(heap.buffer).setBigInt64(sizePtr, BigInt(b?.size ?? 0), true);
        return flags === NOCOPY && b ? b.ptr : 0;
      }),
      sqlite3_js_db_export: jest.fn(() => new Uint8Array([9, 9, 9])),
      sqlite3_get_autocommit: jest.fn(() => 1),
      sqlite3_file_control: jest.fn((db: object, _s: string, op: number, arg: number) => { if (op === SIZE_LIMIT) limits.set(db, new DataView(heap.buffer).getBigInt64(arg, true)); return 0; }),
      sqlite3_last_insert_rowid: jest.fn()
    }
  };
  return { module: module as unknown as SQLiteWasmModule & typeof module, heap, buffers, limits, allocs };
}

describe('SQLiteWasmBridge memory behaviour', () => {
  const bridge = new SQLiteWasmBridge();

  it('opens a database with slack behind it, so the first new page does not double the buffer', () => {
    const { module, buffers } = fakeModule(16 * 1024 * 1024);
    const data = new Uint8Array([1, 2, 3, 4]);
    const db = bridge.deserializeDatabase(module, data);
    const b = buffers.get(db as unknown as object)!;
    expect(b.size).toBe(4);
    expect(b.capacity).toBe(4 + deserializeSlackBytes(4));
  });

  it('falls back to an exact-size buffer when the heap cannot spare the slack', () => {
    const { module, buffers } = fakeModule(64);
    const db = bridge.deserializeDatabase(module, new Uint8Array([1, 2, 3, 4]));
    expect(buffers.get(db as unknown as object)!.capacity).toBe(4);
  });

  it('exports by copying the database straight out of the heap, without the in-heap export copy', () => {
    const { module } = fakeModule(64 * 1024 * 1024);
    const data = new Uint8Array([5, 6, 7, 8, 9]);
    const db = bridge.deserializeDatabase(module, data);
    const out = new Uint8Array(bridge.exportDatabase(module, db));
    expect(Array.from(out)).toEqual([5, 6, 7, 8, 9]);
    expect(module.capi.sqlite3_js_db_export).not.toHaveBeenCalled();
  });

  it('falls back to sqlite3_js_db_export for a database that was never deserialized', () => {
    const { module } = fakeModule();
    const fresh = bridge.createMemoryDatabase(module);
    const out = new Uint8Array(bridge.exportDatabase(module, fresh));
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it('clones heap-to-heap into a buffer with fixed headroom and caps it there', () => {
    const { module, buffers, limits } = fakeModule(64 * 1024 * 1024);
    const live = bridge.deserializeDatabase(module, new Uint8Array([1, 2, 3]));
    module.capi.sqlite3_js_db_export.mockClear();
    const clone = bridge.cloneDatabase(module, live);
    const b = buffers.get(clone as unknown as object)!;
    expect(b.capacity).toBe(3 + PLANNING_CLONE_HEADROOM_BYTES);
    expect(limits.get(clone as unknown as object)).toBe(BigInt(3 + PLANNING_CLONE_HEADROOM_BYTES));
    expect(module.capi.sqlite3_js_db_export).not.toHaveBeenCalled();
    const heap = module.wasm.heap8u();
    expect(Array.from(heap.subarray(b.ptr, b.ptr + 3))).toEqual([1, 2, 3]);
    expect(b.ptr).not.toBe(buffers.get(live as unknown as object)!.ptr);
  });

  it('caps the clone of a never-deserialized database the same way', () => {
    const { module, buffers, limits } = fakeModule(64 * 1024 * 1024);
    module.capi.sqlite3_js_db_export.mockReturnValue(new Uint8Array([4, 5]));
    const fresh = bridge.createMemoryDatabase(module);
    const clone = bridge.cloneDatabase(module, fresh);
    const b = buffers.get(clone as unknown as object)!;
    expect(b.capacity).toBe(2 + PLANNING_CLONE_HEADROOM_BYTES);
    expect(limits.get(clone as unknown as object)).toBe(BigInt(2 + PLANNING_CLONE_HEADROOM_BYTES));
    expect(Array.from(module.wasm.heap8u().subarray(b.ptr, b.ptr + 2))).toEqual([4, 5]);
  });

  it('reports whether a connection is inside a transaction', () => {
    const { module } = fakeModule();
    const db = bridge.createMemoryDatabase(module) as SQLiteDatabaseHandle;
    expect(bridge.isAutocommit(module, db)).toBe(true);
    module.capi.sqlite3_get_autocommit.mockReturnValue(0);
    expect(bridge.isAutocommit(module, db)).toBe(false);
  });

  it('recognises SQLITE_FULL by code and by message', () => {
    expect(isDiskFull({ resultCode: 13 })).toBe(true);
    expect(isDiskFull(new Error('SQLITE_FULL: sqlite3 result code 13: database or disk is full'))).toBe(true);
    expect(isDiskFull(new Error('SQLITE_NOMEM'))).toBe(false);
  });
});
