/**
 * The VFS-backed persistence service, with a fake filesystem.
 *
 * The VFS itself and its failure modes belong to a suite of their own; what is
 * asserted here is the surface the cache manager sees — whether a database is
 * reported present, whether an existing blob becomes the first file rather than
 * a full rebuild, that a save costs nothing, and that a discard actually
 * discards.
 */

import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';
import type {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from '../../src/database/storage/SQLiteWasmBridge';

jest.mock('../../src/utils/desktopRequire', () => ({ desktopRequire: jest.fn() }));

import { VfsPersistenceService } from '../../src/database/storage/VfsPersistenceService';
import { desktopRequire } from '../../src/utils/desktopRequire';

const mockedRequire = desktopRequire as jest.Mock;

const FILE = '/app-data/vault/cache.db';

interface FakeFs {
  statSync: jest.Mock;
  writeFileSync: jest.Mock;
  rmSync: jest.Mock;
}

function fakeFs(fileSize: number | null): FakeFs {
  return {
    statSync: jest.fn(() => {
      if (fileSize === null) throw new Error('ENOENT');
      return { size: fileSize };
    }),
    writeFileSync: jest.fn(),
    rmSync: jest.fn()
  };
}

function fakeBridge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    openFileDatabase: jest.fn(() => ({}) as SQLiteDatabaseHandle),
    exec: jest.fn(),
    close: jest.fn(),
    getIntegrityCheckResult: jest.fn(() => 'ok'),
    ...overrides
  } as unknown as SQLiteWasmBridge & Record<string, jest.Mock>;
}

function fakeBlob(bytes: number | null): CacheBlobStore {
  return {
    getMetadata: jest.fn().mockResolvedValue(bytes === null ? null : { size: bytes }),
    read: jest.fn().mockResolvedValue(bytes === null ? null : new ArrayBuffer(bytes)),
    write: jest.fn(),
    remove: jest.fn()
  } as unknown as CacheBlobStore;
}

function build(fs: FakeFs, bridge: SQLiteWasmBridge, seedSource?: CacheBlobStore) {
  mockedRequire.mockReturnValue(fs);
  return new VfsPersistenceService({ bridge, filePath: FILE, vfsName: 'nexus-nodefs', seedSource });
}

const sqlite3 = {} as SQLiteWasmModule;

describe('hasExistingDatabase', () => {
  it('is true when the file has content', async () => {
    const service = build(fakeFs(4096), fakeBridge(), fakeBlob(null));
    await expect(service.hasExistingDatabase()).resolves.toBe(true);
  });

  it('is true when only the blob has content, because that blob can be seeded', async () => {
    const service = build(fakeFs(null), fakeBridge(), fakeBlob(99_328_000));
    await expect(service.hasExistingDatabase()).resolves.toBe(true);
  });

  it('treats a zero-byte file as absent rather than as an empty database', async () => {
    const service = build(fakeFs(0), fakeBridge(), fakeBlob(null));
    await expect(service.hasExistingDatabase()).resolves.toBe(false);
  });

  it('is false on a genuinely first install', async () => {
    const service = build(fakeFs(null), fakeBridge(), fakeBlob(null));
    await expect(service.hasExistingDatabase()).resolves.toBe(false);
  });
});

describe('loadDatabase', () => {
  it('seeds the file from the blob rather than rebuilding from the event store', async () => {
    const fs = fakeFs(null);
    const bridge = fakeBridge();
    const blob = fakeBlob(2048);
    const service = build(fs, bridge, blob);

    await service.loadDatabase(sqlite3, 'CREATE TABLE t(x);');

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync.mock.calls[0][0]).toBe(FILE);
    expect((fs.writeFileSync.mock.calls[0][1] as Uint8Array).byteLength).toBe(2048);
    // Seeded, so the schema is NOT re-applied over the existing database.
    expect(bridge.exec).not.toHaveBeenCalledWith(expect.anything(), 'CREATE TABLE t(x);');
  });

  it('opens the existing file directly when there is one, without touching the blob', async () => {
    const fs = fakeFs(4096);
    const blob = fakeBlob(2048);
    const service = build(fs, fakeBridge(), blob);

    await service.loadDatabase(sqlite3, 'CREATE TABLE t(x);');

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(blob.read).not.toHaveBeenCalled();
  });

  it('discards the file and rebuilds when the integrity check fails', async () => {
    const fs = fakeFs(4096);
    const bridge = fakeBridge({ getIntegrityCheckResult: jest.fn(() => '*** in database main ***') });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = build(fs, bridge, fakeBlob(null));

    await service.loadDatabase(sqlite3, 'CREATE TABLE t(x);');

    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(fs.rmSync).toHaveBeenCalledWith(FILE, { force: true });
    expect(bridge.exec).toHaveBeenCalledWith(expect.anything(), 'CREATE TABLE t(x);');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('falls back to a fresh database when the seed itself fails', async () => {
    const fs = fakeFs(null);
    fs.writeFileSync.mockImplementation(() => { throw new Error('ENOSPC'); });
    const bridge = fakeBridge();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = build(fs, bridge, fakeBlob(2048));

    await service.loadDatabase(sqlite3, 'CREATE TABLE t(x);');

    expect(bridge.exec).toHaveBeenCalledWith(expect.anything(), 'CREATE TABLE t(x);');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('saveDatabase', () => {
  it('does nothing, because the pages were written at commit', async () => {
    const fs = fakeFs(4096);
    const bridge = fakeBridge();
    const service = build(fs, bridge, fakeBlob(null));

    await service.saveDatabase();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(bridge.exec).not.toHaveBeenCalled();
  });
});

describe('discardExistingDatabase', () => {
  it('removes the file and its rollback journal', async () => {
    const fs = fakeFs(4096);
    const service = build(fs, fakeBridge(), fakeBlob(null));

    await service.discardExistingDatabase();

    expect(fs.rmSync).toHaveBeenCalledWith(FILE, { force: true });
    expect(fs.rmSync).toHaveBeenCalledWith(`${FILE}-journal`, { force: true });
  });

  it('leaves the blob alone — it is still the fallback path data', async () => {
    const blob = fakeBlob(2048);
    const service = build(fakeFs(4096), fakeBridge(), blob);

    await service.discardExistingDatabase();

    expect(blob.remove).not.toHaveBeenCalled();
  });
});

describe('createFreshDatabase', () => {
  it('sets page_size before the schema, which is the only moment it can take', () => {
    const bridge = fakeBridge();
    const service = build(fakeFs(null), bridge, fakeBlob(null));

    service.createFreshDatabase(sqlite3, 'CREATE TABLE t(x);');

    const statements = bridge.exec.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(statements[0]).toContain('page_size');
    expect(statements[statements.length - 1]).toBe('CREATE TABLE t(x);');
  });
});
