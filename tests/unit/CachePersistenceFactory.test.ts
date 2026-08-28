/**
 * The factory's whole job is to decline safely.
 *
 * Mounting a VFS depends on things no compile-time check can see — a Node
 * runtime in the renderer, a writable directory outside the vault, an
 * `installVfs` this WASM build accepts. Every one of those failing has to leave
 * the blob-backed path exactly as it was, because "the old path stays intact" is
 * a stated condition of the work and not a courtesy.
 */

import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';
import type { SQLiteWasmBridge, SQLiteWasmModule } from '../../src/database/storage/SQLiteWasmBridge';

jest.mock('../../src/utils/platform', () => ({ isDesktop: jest.fn(() => true) }));
jest.mock('../../src/utils/desktopRequire', () => ({ desktopRequire: jest.fn() }));
jest.mock('../../src/database/storage/vfs/nodeFsVfs', () => ({ installNodeFsVfs: jest.fn() }));
jest.mock('../../src/database/storage/vfs/cacheFileLocation', () => ({
  resolveCacheFileLocation: jest.fn(() => ({
    dir: '/app-data/vault',
    file: '/app-data/vault/cache.db',
    statsFile: '/app-data/vault/write-stats.jsonl'
  }))
}));

import { tryCreateVfsPersistence } from '../../src/database/storage/CachePersistenceFactory';
import { VfsPersistenceService } from '../../src/database/storage/VfsPersistenceService';
import { installNodeFsVfs } from '../../src/database/storage/vfs/nodeFsVfs';
import { desktopRequire } from '../../src/utils/desktopRequire';
import { resolveCacheFileLocation } from '../../src/database/storage/vfs/cacheFileLocation';

const mockedInstall = installNodeFsVfs as jest.Mock;
const mockedRequire = desktopRequire as jest.Mock;
const mockedLocation = resolveCacheFileLocation as jest.Mock;

function fakeStats() {
  return {
    writeCalls: 0, bytesWritten: 0, readCalls: 0, bytesRead: 0,
    syncs: 0, opens: 0, truncates: 0, deletes: 0, reset: jest.fn()
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    sqlite3: {} as SQLiteWasmModule,
    bridge: {} as SQLiteWasmBridge,
    vaultKey: 'abc:nexus',
    seedSource: { getMetadata: jest.fn(), read: jest.fn() } as unknown as CacheBlobStore,
    ...overrides
  };
}

describe('tryCreateVfsPersistence', () => {
  let mkdirSync: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mkdirSync = jest.fn();
    mockedRequire.mockReturnValue({ mkdirSync });
    mockedLocation.mockReturnValue({
      dir: '/app-data/vault',
      file: '/app-data/vault/cache.db',
      statsFile: '/app-data/vault/write-stats.jsonl'
    });
    mockedInstall.mockReturnValue({ vfsName: 'nexus-nodefs', stats: fakeStats() });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns the VFS-backed service when everything is available', () => {
    const service = tryCreateVfsPersistence(attempt({ forceDesktop: true }));

    expect(service).toBeInstanceOf(VfsPersistenceService);
    expect(mkdirSync).toHaveBeenCalledWith('/app-data/vault', { recursive: true });
    expect(mockedInstall).toHaveBeenCalledTimes(1);
    expect(mockedInstall.mock.calls[0][1]).toMatchObject({ root: '/app-data/vault' });
  });

  it('declines on mobile without touching the filesystem or the module', () => {
    const service = tryCreateVfsPersistence(attempt({ forceDesktop: false }));

    expect(service).toBeNull();
    expect(mockedRequire).not.toHaveBeenCalled();
    expect(mockedInstall).not.toHaveBeenCalled();
    // Declining on mobile is the correct outcome, not a problem to report.
    expect(warn).not.toHaveBeenCalled();
  });

  it('declines, loudly, when the directory cannot be created', () => {
    mkdirSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    expect(tryCreateVfsPersistence(attempt({ forceDesktop: true }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EACCES: permission denied');
  });

  it('declines, loudly, when installVfs rejects this build', () => {
    mockedInstall.mockImplementation(() => { throw new Error('installVfs unavailable'); });

    expect(tryCreateVfsPersistence(attempt({ forceDesktop: true }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('installVfs unavailable');
  });

  it('declines when the desktop module loader is missing, which is how mobile fails late', () => {
    mockedRequire.mockImplementation(() => {
      throw new Error("Cannot load 'node:fs': desktop module loader is unavailable.");
    });

    expect(tryCreateVfsPersistence(attempt({ forceDesktop: true }))).toBeNull();
    expect(mockedInstall).not.toHaveBeenCalled();
  });
});
