/**
 * The node:fs VFS, and above all what it does when the filesystem says no.
 *
 * `VfsPersistenceService.test.ts` covers the surface the cache manager sees.
 * This is the layer underneath it: the twenty-odd C callbacks SQLite invokes
 * through WASM. Two properties matter more here than anywhere else in the
 * plugin, and neither is visible from above.
 *
 * First, **a callback must never throw.** These functions are called from C
 * across the WASM boundary; an exception thrown out of one of them does not
 * become a JavaScript error a caller can catch, it unwinds into a foreign frame.
 * Every method has to convert failure into a return code, including the failure
 * of being handed a pointer it has never seen.
 *
 * Second, **a failed operation must not be counted.** The counters in this file
 * are the instrument the whole initiative is measured with. A counter that moves
 * when nothing reached the disk does not merely lose precision — it produces
 * confident numbers about work that never happened.
 *
 * The crash cases at the end are the other kind of test: they do not assert that
 * something is handled, they pin down what is deliberately *not* handled.
 * `journal_mode=MEMORY` buys one write per page by giving up the on-disk journal
 * that would roll a torn commit back. That exposure was priced and accepted in
 * `VfsPersistenceService`; these tests are what make it a described property
 * rather than a surprise.
 */

import {
  CAPI_CONSTANTS,
  createFakeDisk,
  createFakeSqlite3,
  enospc,
  eio,
  fakePath,
  type FakeDisk,
  type FakeSqlite3
} from './nodeFsVfsHarness';

jest.mock('../../src/utils/desktopRequire', () => ({ desktopRequire: jest.fn() }));

import { installNodeFsVfs, type InstalledNodeFsVfs } from '../../src/database/storage/vfs/nodeFsVfs';
import { desktopRequire } from '../../src/utils/desktopRequire';

const mockedRequire = desktopRequire as jest.Mock;

const ROOT = '/app-data/261a43a48138a99a-nexus';
const DB = 'cache.db';
const DB_PATH = fakePath.join(ROOT, DB);

/** The captured callbacks are C-shaped; `never[]` is unusable from a test. */
type Callbacks = Record<string, (...args: number[]) => number>;

interface Mounted {
  vfs: InstalledNodeFsVfs;
  io: Callbacks;
  methods: Callbacks;
  disk: FakeDisk;
  sqlite3: FakeSqlite3;
  /** Allocate a pFile slot and open `name` through xOpen. */
  open(name: string | null, flags?: number): number;
  /** Allocate scratch heap and fill it with a recognisable pattern. */
  page(byte: number, size?: number): number;
}

function mount(configure?: (sqlite3: FakeSqlite3, disk: FakeDisk) => void): Mounted {
  const sqlite3 = createFakeSqlite3();
  const disk = createFakeDisk();
  configure?.(sqlite3, disk);

  mockedRequire.mockImplementation((id: string) => {
    if (id === 'node:fs') return disk.fs;
    if (id === 'node:path') return fakePath;
    throw new Error(`unexpected desktopRequire(${id})`);
  });

  const vfs = installNodeFsVfs(sqlite3.module as never, { root: ROOT });
  const io = sqlite3.captured.io!.methods as unknown as Callbacks;
  const methods = sqlite3.captured.vfs!.methods as unknown as Callbacks;

  return {
    vfs, io, methods, disk, sqlite3,
    open(name, flags = CAPI_CONSTANTS.SQLITE_OPEN_READWRITE | CAPI_CONSTANTS.SQLITE_OPEN_CREATE) {
      const pFile = sqlite3.wasm.alloc(96);
      const zName = name === null ? 0 : sqlite3.wasm.allocCString(name);
      const result = methods.xOpen(0, zName, pFile, flags, 0);
      if (result !== 0) throw new Error(`xOpen failed with ${result}`);
      return pFile;
    },
    page(byte, size = 4096) {
      const pointer = sqlite3.wasm.alloc(size);
      sqlite3.wasm.heap.fill(byte, pointer, pointer + size);
      return pointer;
    }
  };
}

beforeEach(() => {
  mockedRequire.mockReset();
});

/* ------------------------------------------------------------------ mounting */

describe('mounting', () => {
  it('registers the io methods and the vfs, in that order, describing itself to SQLite', () => {
    const m = mount();

    expect(m.sqlite3.captured.io!.struct.$iVersion).toBe(1);
    expect(m.sqlite3.captured.vfs!.struct.$iVersion).toBe(2);
    expect(m.sqlite3.captured.vfs!.struct.$szOsFile).toBe(96);
    expect(m.sqlite3.captured.vfs!.struct.$mxPathname).toBe(1024);
    expect(m.vfs.vfsName).toBe('nodefs');
    expect(m.vfs.openFileCount()).toBe(0);
  });

  it('refuses to register twice under the same name', () => {
    expect(() => mount((sqlite3) => sqlite3.registered.add('nodefs')))
      .toThrow(/already registered/);
  });

  it('supplies its own randomness and sleep when there is no default VFS to inherit from', () => {
    const m = mount((sqlite3) => { sqlite3.defaultVfsPointer = 0; });

    expect(typeof m.methods.xRandomness).toBe('function');
    expect(typeof m.methods.xSleep).toBe('function');

    const pOut = m.sqlite3.wasm.alloc(32);
    expect(m.methods.xRandomness(0, 32, pOut)).toBe(32);
    expect(m.sqlite3.wasm.heap.subarray(pOut, pOut + 32).some((b) => b !== 0)).toBe(true);
  });

  it('inherits randomness and sleep from the default VFS when one exists', () => {
    const m = mount((sqlite3) => {
      sqlite3.defaultVfsPointer = 4242;
      sqlite3.defaultVfsFields = { $xRandomness: 111, $xSleep: 222 };
    });

    expect(m.sqlite3.captured.vfs!.struct.$xRandomness).toBe(111);
    expect(m.sqlite3.captured.vfs!.struct.$xSleep).toBe(222);
    // Inheriting means not shadowing: a JS implementation installed alongside
    // the inherited pointer would be dead code that looks live.
    expect(m.methods.xRandomness).toBeUndefined();
    expect(m.methods.xSleep).toBeUndefined();
  });
});

/* --------------------------------------------------------------------- xOpen */

describe('xOpen', () => {
  it('resolves a relative name under the root and an absolute one as given', () => {
    const m = mount();

    m.open(DB);
    expect(m.disk.files.has(DB_PATH)).toBe(true);

    m.open('/elsewhere/other.db');
    expect(m.disk.files.has('/elsewhere/other.db')).toBe(true);
  });

  it('translates SQLite open flags into filesystem flags', () => {
    const m = mount();
    const { SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE, SQLITE_OPEN_EXCLUSIVE } = CAPI_CONSTANTS;

    m.disk.files.set(DB_PATH, new Uint8Array(0));
    m.open(DB, SQLITE_OPEN_READONLY);
    expect(m.disk.fs.openSync).toHaveBeenLastCalledWith(DB_PATH, 0, 0o644);

    m.open('fresh.db', SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    expect(m.disk.fs.openSync).toHaveBeenLastCalledWith(fakePath.join(ROOT, 'fresh.db'), 2 | 512, 0o644);

    m.open('exclusive.db', SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXCLUSIVE);
    expect(m.disk.fs.openSync).toHaveBeenLastCalledWith(fakePath.join(ROOT, 'exclusive.db'), 2 | 512 | 2048, 0o644);
  });

  it('invents a name under the root when SQLite asks for an unnamed temporary file', () => {
    const m = mount();

    m.open(null);

    const created = [...m.disk.files.keys()];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(new RegExp(`^${ROOT}/sqlite-tmp-`));
    expect(m.vfs.openFileCount()).toBe(1);
  });

  it('reports SQLITE_CANTOPEN and leaves nothing open when the file cannot be opened', () => {
    const m = mount();
    m.disk.failAlways('openSync', eio('open'));

    const pFile = m.sqlite3.wasm.alloc(96);
    const zName = m.sqlite3.wasm.allocCString(DB);

    expect(m.methods.xOpen(0, zName, pFile, CAPI_CONSTANTS.SQLITE_OPEN_CREATE, 0))
      .toBe(CAPI_CONSTANTS.SQLITE_CANTOPEN);
    expect(m.vfs.openFileCount()).toBe(0);
    expect(m.disk.openFds.size).toBe(0);
    expect(m.vfs.stats.opens).toBe(0);
  });

  it('closes the descriptor when the open fails after the file is already open', () => {
    // The window between `openSync` and returning success is short but real: the
    // struct binding allocates, and an allocation can fail. SQLite is told the
    // open failed, so it will never call xClose — whatever is still open here is
    // open for the lifetime of the process.
    const m = mount();
    m.sqlite3.failNextFileStruct = new Error('out of memory binding sqlite3_file');

    const pFile = m.sqlite3.wasm.alloc(96);
    const zName = m.sqlite3.wasm.allocCString(DB);

    expect(m.methods.xOpen(0, zName, pFile, CAPI_CONSTANTS.SQLITE_OPEN_CREATE, 0))
      .toBe(CAPI_CONSTANTS.SQLITE_CANTOPEN);
    expect(m.disk.openFds.size).toBe(0);
    expect(m.vfs.openFileCount()).toBe(0);
  });

  it('writes the granted flags back when SQLite asks for them', () => {
    const m = mount();
    const pFile = m.sqlite3.wasm.alloc(96);
    const zName = m.sqlite3.wasm.allocCString(DB);
    const pOutFlags = m.sqlite3.wasm.alloc(4);
    const flags = CAPI_CONSTANTS.SQLITE_OPEN_READWRITE | CAPI_CONSTANTS.SQLITE_OPEN_CREATE;

    expect(m.methods.xOpen(0, zName, pFile, flags, pOutFlags)).toBe(0);
    expect(m.sqlite3.wasm.read32(pOutFlags)).toBe(flags);
  });
});

/* --------------------------------------------------------------------- xRead */

describe('xRead', () => {
  it('reads into the heap at the requested offset and counts what it got', () => {
    const m = mount();
    const contents = new Uint8Array(8192);
    contents.fill(0xab, 4096, 8192);
    m.disk.files.set(DB_PATH, contents);

    const pFile = m.open(DB);
    const pDest = m.page(0x00);

    expect(m.io.xRead(pFile, pDest, 4096, 4096)).toBe(0);
    expect(m.sqlite3.wasm.heap.subarray(pDest, pDest + 4096).every((b) => b === 0xab)).toBe(true);
    expect(m.vfs.stats.readCalls).toBe(1);
    expect(m.vfs.stats.bytesRead).toBe(4096);
  });

  it('zeroes the unread tail of a short read instead of leaving whatever the heap held', () => {
    // The tail is not cosmetic. SQLite reads a partial page at the end of a file
    // and expects the remainder to be zero; leftover heap bytes there are read
    // as database content.
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(100).fill(0x11));

    const pFile = m.open(DB);
    const pDest = m.page(0xff);

    expect(m.io.xRead(pFile, pDest, 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_SHORT_READ);
    expect(m.sqlite3.wasm.heap.subarray(pDest, pDest + 100).every((b) => b === 0x11)).toBe(true);
    expect(m.sqlite3.wasm.heap.subarray(pDest + 100, pDest + 4096).every((b) => b === 0x00)).toBe(true);
    expect(m.vfs.stats.bytesRead).toBe(100);
  });

  it('reports an io error without counting anything when the read throws', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(4096));
    const pFile = m.open(DB);
    m.disk.failAlways('readSync', eio('read'));

    expect(m.io.xRead(pFile, m.page(0), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_READ);
    expect(m.vfs.stats.readCalls).toBe(0);
    expect(m.vfs.stats.bytesRead).toBe(0);
  });

  it('returns an error rather than throwing for a file it has never seen', () => {
    const m = mount();
    expect(() => m.io.xRead(9999, m.page(0), 4096, 0)).not.toThrow();
    expect(m.io.xRead(9999, m.page(0), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_READ);
  });
});

/* -------------------------------------------------------------------- xWrite */

describe('xWrite', () => {
  it('writes the page at the offset and counts it', () => {
    const m = mount();
    const pFile = m.open(DB);
    const pSrc = m.page(0x5a);

    expect(m.io.xWrite(pFile, pSrc, 4096, 8192)).toBe(0);

    const written = m.disk.files.get(DB_PATH)!;
    expect(written).toHaveLength(12288);
    expect(written.subarray(8192, 12288).every((b) => b === 0x5a)).toBe(true);
    expect(m.vfs.stats.writeCalls).toBe(1);
    expect(m.vfs.stats.bytesWritten).toBe(4096);
  });

  it('counts nothing when the disk is full', () => {
    // A counter that moves on ENOSPC reports bytes that are not on the disk, and
    // the whole point of these counters is that they are measurements.
    const m = mount();
    const pFile = m.open(DB);
    m.disk.failAlways('writeSync', enospc());

    expect(m.io.xWrite(pFile, m.page(0x5a), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_WRITE);
    expect(m.vfs.stats.writeCalls).toBe(0);
    expect(m.vfs.stats.bytesWritten).toBe(0);
    expect(m.disk.files.get(DB_PATH)).toHaveLength(0);
  });

  it('fails a short write, and counts only the bytes that actually landed', () => {
    const m = mount();
    const pFile = m.open(DB);
    m.disk.shortWriteTo = 1024;

    expect(m.io.xWrite(pFile, m.page(0x5a), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_WRITE);
    expect(m.vfs.stats.bytesWritten).toBe(1024);
    expect(m.disk.files.get(DB_PATH)).toHaveLength(1024);
  });

  it('returns an error rather than throwing for a file it has never seen', () => {
    const m = mount();
    expect(() => m.io.xWrite(9999, m.page(0), 4096, 0)).not.toThrow();
    expect(m.io.xWrite(9999, m.page(0), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_WRITE);
  });
});

/* --------------------------------------------- xSync, xTruncate and xFileSize */

describe('xSync, xTruncate and xFileSize', () => {
  it('syncs and counts, and does neither when the sync fails', () => {
    const m = mount();
    const pFile = m.open(DB);

    expect(m.io.xSync(pFile, 0)).toBe(0);
    expect(m.vfs.stats.syncs).toBe(1);

    m.disk.failAlways('fsyncSync', eio('fsync'));
    expect(m.io.xSync(pFile, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_FSYNC);
    expect(m.vfs.stats.syncs).toBe(1);
  });

  it('truncates and counts, and does neither when the truncate fails', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(8192).fill(0x77));
    const pFile = m.open(DB);

    expect(m.io.xTruncate(pFile, 4096)).toBe(0);
    expect(m.disk.files.get(DB_PATH)).toHaveLength(4096);
    expect(m.vfs.stats.truncates).toBe(1);

    m.disk.failAlways('ftruncateSync', eio('ftruncate'));
    expect(m.io.xTruncate(pFile, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_TRUNCATE);
    expect(m.vfs.stats.truncates).toBe(1);
    expect(m.disk.files.get(DB_PATH)).toHaveLength(4096);
  });

  it('reports the size as a 64-bit integer, and errors without poking on failure', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(12288));
    const pFile = m.open(DB);
    const pSize = m.sqlite3.wasm.alloc(8);

    expect(m.io.xFileSize(pFile, pSize)).toBe(0);
    expect(m.sqlite3.wasm.readI64(pSize)).toBe(12288n);

    m.disk.failAlways('fstatSync', eio('fstat'));
    expect(m.io.xFileSize(pFile, pSize)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_FSTAT);
    expect(m.sqlite3.wasm.readI64(pSize)).toBe(12288n);
  });

  it('returns errors rather than throwing for a file it has never seen', () => {
    const m = mount();
    expect(m.io.xSync(9999, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_FSYNC);
    expect(m.io.xTruncate(9999, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_TRUNCATE);
    expect(m.io.xFileSize(9999, m.sqlite3.wasm.alloc(8))).toBe(CAPI_CONSTANTS.SQLITE_IOERR_FSTAT);
  });
});

/* -------------------------------------------------------------------- xClose */

describe('xClose', () => {
  it('closes the descriptor and forgets the file', () => {
    const m = mount();
    const pFile = m.open(DB);

    expect(m.io.xClose(pFile)).toBe(0);
    expect(m.vfs.openFileCount()).toBe(0);
    expect(m.disk.openFds.size).toBe(0);
    expect(m.disk.files.has(DB_PATH)).toBe(true);
  });

  it('deletes the file afterwards when it was opened DELETEONCLOSE', () => {
    const m = mount();
    const pFile = m.open('journal.tmp', CAPI_CONSTANTS.SQLITE_OPEN_CREATE | CAPI_CONSTANTS.SQLITE_OPEN_DELETEONCLOSE);

    expect(m.io.xClose(pFile)).toBe(0);
    expect(m.disk.files.has(fakePath.join(ROOT, 'journal.tmp'))).toBe(false);
  });

  it('still succeeds when a DELETEONCLOSE file has already been deleted', () => {
    const m = mount();
    const pFile = m.open('journal.tmp', CAPI_CONSTANTS.SQLITE_OPEN_CREATE | CAPI_CONSTANTS.SQLITE_OPEN_DELETEONCLOSE);
    m.disk.files.delete(fakePath.join(ROOT, 'journal.tmp'));

    expect(m.io.xClose(pFile)).toBe(0);
  });

  it('forgets the file even when closing it fails', () => {
    // SQLite does not retry xClose. Keeping the entry after a failed close
    // leaves a descriptor that nothing will ever close again, and makes
    // openFileCount() — the leak check itself — report the leak as normal.
    const m = mount();
    const pFile = m.open(DB);
    m.disk.failAlways('closeSync', eio('close'));

    expect(m.io.xClose(pFile)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_CLOSE);
    expect(m.vfs.openFileCount()).toBe(0);
  });

  it('is idempotent for a file it has never seen', () => {
    const m = mount();
    expect(m.io.xClose(9999)).toBe(0);
  });
});

/* ---------------------------------------- xDelete, xAccess and xFullPathname */

describe('xDelete, xAccess and xFullPathname', () => {
  it('deletes an existing file and counts it', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(10));

    expect(m.methods.xDelete(0, m.sqlite3.wasm.allocCString(DB), 0)).toBe(0);
    expect(m.disk.files.has(DB_PATH)).toBe(false);
    expect(m.vfs.stats.deletes).toBe(1);
  });

  it('treats deleting an absent file as success, and does not count it', () => {
    const m = mount();

    expect(m.methods.xDelete(0, m.sqlite3.wasm.allocCString('gone.db'), 0)).toBe(0);
    expect(m.vfs.stats.deletes).toBe(0);
  });

  it('reports an io error when the delete itself fails', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(10));
    m.disk.failAlways('unlinkSync', eio('unlink'));

    expect(m.methods.xDelete(0, m.sqlite3.wasm.allocCString(DB), 0))
      .toBe(CAPI_CONSTANTS.SQLITE_IOERR_DELETE);
  });

  it('answers existence questions, and answers "no" when it cannot tell', () => {
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(1));
    const pOut = m.sqlite3.wasm.alloc(4);

    expect(m.methods.xAccess(0, m.sqlite3.wasm.allocCString(DB), 0, pOut)).toBe(0);
    expect(m.sqlite3.wasm.read32(pOut)).toBe(1);

    expect(m.methods.xAccess(0, m.sqlite3.wasm.allocCString('absent.db'), 0, pOut)).toBe(0);
    expect(m.sqlite3.wasm.read32(pOut)).toBe(0);

    m.disk.failAlways('existsSync', eio('stat'));
    expect(m.methods.xAccess(0, m.sqlite3.wasm.allocCString(DB), 0, pOut)).toBe(0);
    expect(m.sqlite3.wasm.read32(pOut)).toBe(0);
  });

  it('writes the resolved absolute path back to SQLite', () => {
    const m = mount();
    const pOut = m.sqlite3.wasm.alloc(1024);

    expect(m.methods.xFullPathname(0, m.sqlite3.wasm.allocCString(DB), 1024, pOut)).toBe(0);

    const end = m.sqlite3.wasm.heap.indexOf(0, pOut);
    expect(new TextDecoder().decode(m.sqlite3.wasm.heap.subarray(pOut, end))).toBe(DB_PATH);
  });

  it('refuses a path longer than the buffer, and still pops its allocation scope', () => {
    const m = mount();
    const pOut = m.sqlite3.wasm.alloc(8);

    expect(m.methods.xFullPathname(0, m.sqlite3.wasm.allocCString(DB), 8, pOut))
      .toBe(CAPI_CONSTANTS.SQLITE_CANTOPEN);
    expect(m.sqlite3.wasm.openScopes()).toBe(0);
  });
});

/* ------------------------------------------------------------------- locking */

describe('locking', () => {
  it('agrees to every lock level, which is the declared single-process contract', () => {
    const m = mount();
    const pFile = m.open(DB);
    const pOut = m.sqlite3.wasm.alloc(4);

    expect(m.io.xLock(pFile, CAPI_CONSTANTS.SQLITE_LOCK_EXCLUSIVE)).toBe(0);
    expect(m.io.xUnlock(pFile, CAPI_CONSTANTS.SQLITE_LOCK_NONE)).toBe(0);

    // Always "no reserved lock": there is no second process that could hold one.
    m.sqlite3.wasm.heap.fill(0xff, pOut, pOut + 4);
    expect(m.io.xCheckReservedLock(pFile, pOut)).toBe(0);
    expect(m.sqlite3.wasm.read32(pOut)).toBe(0);
  });

  it('does not throw when asked to lock a file it has never seen', () => {
    const m = mount();
    expect(m.io.xLock(9999, CAPI_CONSTANTS.SQLITE_LOCK_SHARED)).toBe(0);
    expect(m.io.xUnlock(9999, CAPI_CONSTANTS.SQLITE_LOCK_NONE)).toBe(0);
  });

  it('declines file controls and reports a 4 KiB sector with no special guarantees', () => {
    const m = mount();
    expect(m.io.xFileControl()).toBe(CAPI_CONSTANTS.SQLITE_NOTFOUND);
    expect(m.io.xSectorSize()).toBe(4096);
    // Zero characteristics: no atomic writes, no ordered appends. Claiming any
    // of them here would let SQLite skip a barrier this VFS does not provide.
    expect(m.io.xDeviceCharacteristics()).toBe(0);
  });
});

/* --------------------------------------------------- a commit that is cut off */

describe('a commit interrupted mid-write', () => {
  it('leaves the pages that landed on disk and reports the one that did not', () => {
    // This is the exposure `journal_mode=MEMORY` buys the halved write with.
    // With an on-disk rollback journal the next open would undo page 0; here
    // nothing will, and the file carries a page from the new transaction beside
    // pages from the old one. The test exists so that property is written down
    // rather than discovered.
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(12288).fill(0x01));
    const pFile = m.open(DB);

    expect(m.io.xWrite(pFile, m.page(0x02), 4096, 0)).toBe(0);
    m.disk.failAlways('writeSync', enospc());
    expect(m.io.xWrite(pFile, m.page(0x02), 4096, 4096)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_WRITE);

    const torn = m.disk.files.get(DB_PATH)!;
    expect(torn.subarray(0, 4096).every((b) => b === 0x02)).toBe(true);
    expect(torn.subarray(4096, 12288).every((b) => b === 0x01)).toBe(true);
    expect(m.vfs.stats.writeCalls).toBe(1);
  });

  it('keeps serving the file after a failed write, so SQLite can roll back in memory', () => {
    // The in-memory journal is the only thing that can undo the torn write, and
    // it can only do so through this same handle. A VFS that invalidated the
    // descriptor on the first ENOSPC would take the rollback down with it.
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(8192).fill(0x01));
    const pFile = m.open(DB);

    m.disk.failOnce('writeSync', enospc());
    expect(m.io.xWrite(pFile, m.page(0x02), 4096, 0)).toBe(CAPI_CONSTANTS.SQLITE_IOERR_WRITE);

    expect(m.io.xWrite(pFile, m.page(0x01), 4096, 0)).toBe(0);
    expect(m.io.xSync(pFile, 0)).toBe(0);
    expect(m.disk.files.get(DB_PATH)!.every((b) => b === 0x01)).toBe(true);
  });

  it('survives the filesystem failing every operation at once', () => {
    // A disk that has gone away answers nothing. Every callback still has to
    // return a code, because there is no frame above these to catch a throw.
    const m = mount();
    m.disk.files.set(DB_PATH, new Uint8Array(4096));
    const pFile = m.open(DB);
    (['readSync', 'writeSync', 'fsyncSync', 'ftruncateSync', 'fstatSync', 'closeSync'] as const)
      .forEach((op) => m.disk.failAlways(op, eio(op)));

    expect(() => {
      m.io.xRead(pFile, m.page(0), 4096, 0);
      m.io.xWrite(pFile, m.page(0), 4096, 0);
      m.io.xSync(pFile, 0);
      m.io.xTruncate(pFile, 0);
      m.io.xFileSize(pFile, m.sqlite3.wasm.alloc(8));
      m.io.xClose(pFile);
    }).not.toThrow();
  });
});
