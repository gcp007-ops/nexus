jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import type { App } from 'obsidian';

import { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

function harness() {
  let inTransaction = false;
  let exported = 0;
  const dbHandle = { exec: jest.fn(), prepare: jest.fn(), close: jest.fn(), changes: jest.fn(() => 0), selectValue: jest.fn(() => 'ok') };
  const cloneHandle = { ...dbHandle, close: jest.fn() };
  const sqlite3 = { oo1: {}, wasm: {}, capi: {} };
  const bridge = {
    exportDatabase: jest.fn(() => { exported++; return new ArrayBuffer(16); }),
    cloneDatabase: jest.fn(() => cloneHandle),
    deserializeDatabase: jest.fn(() => dbHandle),
    isAutocommit: jest.fn(() => !inTransaction),
    exec: jest.fn(),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    query: jest.fn(() => []),
    queryOne: jest.fn(() => null),
    close: jest.fn()
  };
  const blobStore = { read: jest.fn(), write: jest.fn(async () => undefined), remove: jest.fn(), getMetadata: jest.fn() };
  const manager = new SQLiteCacheManager({
    app: { vault: { configDir: '.obsidian', adapter: {} } } as unknown as App,
    dbPath: '.nexus/data/cache.db',
    autoSaveInterval: 0,
    blobStore: blobStore as unknown as CacheBlobStore
  });
  const internals = manager as unknown as Record<string, unknown>;
  internals.bridge = bridge;
  internals.db = dbHandle;
  internals.sqlite3 = sqlite3;
  internals.isInitialized = true;
  internals.persistenceService = new SQLitePersistenceService({
    blobStore: blobStore as unknown as CacheBlobStore,
    bridge: bridge as unknown as ConstructorParameters<typeof SQLitePersistenceService>[0]['bridge']
  });
  return {
    manager, bridge, cloneHandle,
    exported: () => exported,
    setInTransaction: (v: boolean) => { inTransaction = v; },
    internals
  };
}

describe('SQLiteCacheManager planning clone memory', () => {
  it('builds the planning clone heap-to-heap, never through a full export', () => {
    const h = harness();
    const clone = h.manager.createPlanningClone();
    expect(h.bridge.cloneDatabase).toHaveBeenCalled();
    expect(h.bridge.exportDatabase).not.toHaveBeenCalled();
    clone.dispose();
    expect(h.bridge.close).toHaveBeenCalledWith(h.cloneHandle);
  });

  it('turns a clone that outgrew its headroom into a planning error, not an opaque SQLITE_FULL', async () => {
    const h = harness();
    h.bridge.run.mockImplementation(() => { throw new Error('SQLITE_FULL: sqlite3 result code 13: database or disk is full'); });
    const clone = h.manager.createPlanningClone();
    // The facade keeps the old shape: a failing statement throws from run()
    // itself, which an awaiting caller sees as a rejection.
    await expect((async () => clone.cache.run('INSERT INTO t VALUES (1)'))()).rejects.toThrow('Planning clone ran out of its fixed headroom');
  });

  it('reports a headroom overflow inside a transaction as the planning error, not a failed rollback', async () => {
    const h = harness();
    let open = false;
    h.bridge.isAutocommit.mockImplementation(() => !open);
    h.bridge.exec.mockImplementation((_db: unknown, sql: string) => {
      if (sql === 'BEGIN') open = true;
      if (sql === 'ROLLBACK') { if (!open) throw new Error('cannot rollback - no transaction is active'); open = false; }
    });
    h.bridge.run.mockImplementation(() => { open = false; throw new Error('SQLITE_FULL: sqlite3 result code 13: database or disk is full'); });
    const clone = h.manager.createPlanningClone();
    await expect(clone.cache.transaction(async () => { await clone.cache.run('INSERT INTO t VALUES (1)'); }))
      .rejects.toThrow('Planning clone ran out of its fixed headroom');
  });
});
