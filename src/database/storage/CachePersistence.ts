/**
 * How the cache database is materialised, in the two shapes that exist.
 *
 * `SQLitePersistenceService` holds the whole database in memory and moves it in
 * and out of a `CacheBlobStore` by serialising it. `VfsPersistenceService` opens
 * a file through a VFS and lets SQLite write the pages it changed. They differ
 * in what a save costs — everything, versus nothing — so the seam is here rather
 * than in a branch inside one of them, matching how `CacheBlobStoreFactory`
 * already selects a backing store.
 */

import type { SQLiteWasmModule, SQLiteDatabaseHandle } from './SQLiteWasmBridge';

export interface CachePersistence {
  /**
   * Whether `saveDatabase()` writes the database, as opposed to being a no-op
   * over pages that a commit already put on disk.
   *
   * The auto-save budget exists to bound the cost of a save, and that cost is
   * proportional to the size of the database only on the export path. Under the
   * VFS it is zero at any size, so deriving the period from the size measures
   * something that no longer happens — and would tighten it as a `VACUUM`
   * shrinks the file, buying nothing at a price. Backends declare which they
   * are rather than the scheduler guessing from a `instanceof`.
   */
  readonly saveWritesWholeDatabase: boolean;

  /**
   * Whether there is a database to open, as opposed to one to create.
   *
   * Asked before `loadDatabase` so the caller does not have to know whether
   * "exists" means a blob record or a file on disk.
   */
  hasExistingDatabase(): Promise<boolean>;

  /** Open the existing database, recovering to a fresh one if it is unusable. */
  loadDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle>;

  /**
   * Persist the current state.
   *
   * Under the VFS this is a no-op: the pages were already on disk when the
   * transaction committed. Callers must not read a cheap save as a failed one.
   */
  saveDatabase(sqlite3: SQLiteWasmModule, db: SQLiteDatabaseHandle): Promise<void>;

  /** Create an empty database with the schema applied. */
  createFreshDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): SQLiteDatabaseHandle;

  /**
   * Throw away what is persisted, so the next open starts from nothing.
   *
   * The "Nexus: Rebuild cache" command depends on this and used to reach past
   * the persistence layer to remove the blob directly. That is a correct
   * instruction to one backend and a no-op against the other, and a rebuild
   * that silently reopens the stale cache is worse than one that fails — hence
   * the operation belongs to whichever backend is actually in use.
   */
  discardExistingDatabase(): Promise<void>;
}
