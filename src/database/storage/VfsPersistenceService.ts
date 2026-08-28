/**
 * Cache persistence backed by a file on a node:fs VFS.
 *
 * The counterpart of `SQLitePersistenceService`. There, the database lives in
 * memory and a save serialises all of it; here the database lives in a file and
 * a save has nothing left to do, because the pages were written when the
 * transaction committed.
 *
 * Desktop only, and only when the VFS actually mounted. The caller owns that
 * decision — see `CachePersistenceFactory` — so this class assumes it is
 * already on a working VFS and does not re-check.
 */

import type { CacheBlobStore } from './CacheBlobStore';
import type { CachePersistence } from './CachePersistence';
import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';
import { desktopRequire } from '../../utils/desktopRequire';

/**
 * `TRUNCATE` rather than `DELETE` avoids re-creating the journal file on every
 * transaction; `NORMAL` avoids an fsync per commit without giving up the
 * journal. WAL is deliberately absent — it needs `xShm*`, which this VFS does
 * not implement.
 */
const OPEN_PRAGMAS = 'PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=NORMAL;';

/** Must be set before the first table exists, so it only applies to a fresh file. */
const FRESH_FILE_PRAGMAS = 'PRAGMA page_size=4096;';

export interface VfsPersistenceServiceOptions {
  bridge: SQLiteWasmBridge;
  /** Absolute path of the database file, outside the vault. */
  filePath: string;
  /** Name the VFS registered under. */
  vfsName: string;
  /**
   * The blob store this replaces. Read once, to seed the file on the first run
   * so an existing cache is carried over instead of rebuilt. Never written.
   */
  seedSource?: CacheBlobStore;
}

export class VfsPersistenceService implements CachePersistence {
  private readonly bridge: SQLiteWasmBridge;
  private readonly filePath: string;
  private readonly vfsName: string;
  private readonly seedSource?: CacheBlobStore;

  constructor(options: VfsPersistenceServiceOptions) {
    this.bridge = options.bridge;
    this.filePath = options.filePath;
    this.vfsName = options.vfsName;
    this.seedSource = options.seedSource;
  }

  /**
   * True when there is a file to open, or a blob that can become one.
   *
   * The blob arm matters on the first run after switching: without it the cache
   * would be reported absent, rebuilt from the JSONL event store, and the user
   * would pay a full replay for a database that was sitting right there.
   */
  async hasExistingDatabase(): Promise<boolean> {
    if (this.fileHasContent()) {
      return true;
    }
    if (!this.seedSource) {
      return false;
    }
    const meta = await this.seedSource.getMetadata();
    return meta !== null && meta.size > 0;
  }

  async loadDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    if (!this.fileHasContent()) {
      const seeded = await this.seedFromBlob();
      if (!seeded) {
        return this.createFreshDatabase(sqlite3, schemaSql);
      }
    }

    try {
      const db = this.openExisting(sqlite3);

      const integrityResult = this.bridge.getIntegrityCheckResult(db);
      if (integrityResult !== 'ok') {
        const detail = typeof integrityResult === 'string'
          ? integrityResult
          : JSON.stringify(integrityResult) ?? 'unknown';
        this.bridge.close(db);
        throw new Error(`Database integrity check failed: ${detail}`);
      }

      return db;
    } catch (error) {
      this.reportRebuild(error);
      this.removeFile();
      return this.createFreshDatabase(sqlite3, schemaSql);
    }
  }

  /**
   * Nothing to do, and that is the entire point of this class.
   *
   * Kept as a real method rather than dropped from the interface because the
   * cache manager's auto-save tick, its final save on close and its post-
   * migration save all call it. They stay correct and become free; deciding
   * whether the auto-save budget should still exist at all is a separate
   * question from making it cheap.
   */
  saveDatabase(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Delete the file and its journal.
   *
   * Note what is NOT deleted: the blob this was seeded from. Removing it is the
   * separate question of what happens to the orphaned blob, and answering it
   * here would make a rebuild destroy the only copy of the fallback path's data.
   */
  discardExistingDatabase(): Promise<void> {
    this.removeFile();
    return Promise.resolve();
  }

  createFreshDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): SQLiteDatabaseHandle {
    this.removeFile();
    const db = this.bridge.openFileDatabase(sqlite3, this.filePath, this.vfsName);
    this.bridge.exec(db, FRESH_FILE_PRAGMAS);
    this.bridge.exec(db, OPEN_PRAGMAS);
    this.bridge.exec(db, schemaSql);
    return db;
  }

  private openExisting(sqlite3: SQLiteWasmModule): SQLiteDatabaseHandle {
    const db = this.bridge.openFileDatabase(sqlite3, this.filePath, this.vfsName);
    this.bridge.exec(db, OPEN_PRAGMAS);
    return db;
  }

  /**
   * Write the existing blob out as the initial file.
   *
   * `sqlite3_js_db_export()` produces the on-disk format byte for byte, so the
   * blob already *is* a database file — seeding is a copy, not a conversion. The
   * one-shot migration proper, its rollback and the fate of the orphaned blob
   * are a separate deliverable; this is only what it takes for the first launch
   * on the VFS to open the cache the user already had.
   *
   * Returns false when there was nothing to seed from, which is the ordinary
   * first-install case and not a failure.
   */
  private async seedFromBlob(): Promise<boolean> {
    if (!this.seedSource) {
      return false;
    }

    try {
      const data = await this.seedSource.read();
      if (!data || data.byteLength === 0) {
        return false;
      }

      const fs = desktopRequire<typeof import('node:fs')>('node:fs');
      fs.writeFileSync(this.filePath, new Uint8Array(data));
      return true;
    } catch (error) {
      // Not fatal: a failed seed costs a rebuild from the event store, which is
      // exactly what would have happened without a seed at all.
      console.warn(
        '[VfsPersistenceService] Could not seed the cache file from the existing blob; ' +
        'the cache will be rebuilt from the event store instead.',
        error
      );
      return false;
    }
  }

  private fileHasContent(): boolean {
    try {
      const fs = desktopRequire<typeof import('node:fs')>('node:fs');
      return fs.statSync(this.filePath).size > 0;
    } catch {
      return false;
    }
  }

  private removeFile(): void {
    try {
      const fs = desktopRequire<typeof import('node:fs')>('node:fs');
      fs.rmSync(this.filePath, { force: true });
      // The rollback journal is derived from the database file. Left behind
      // beside a fresh file it would be read as that file's journal.
      fs.rmSync(`${this.filePath}-journal`, { force: true });
    } catch {
      // The open below reports the real problem if the path is genuinely unusable.
    }
  }

  /**
   * Say a rebuild happened, in the same voice and for the same reason as
   * `SQLitePersistenceService.reportCacheRebuild`: the silent version of this
   * path left issue #209 undiagnosable for months.
   */
  private reportRebuild(cause: unknown): void {
    const causeText = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `[VfsPersistenceService] Cache database at ${this.filePath} could not be opened or failed its ` +
      `integrity check — discarding it and rebuilding from scratch. Cause: ${causeText}. ` +
      'This deletes no user data of its own: the SQLite cache is a derived index and the JSONL event ' +
      'store is the source of truth. If this line appears on every start, the cache is being corrupted ' +
      'again after each rebuild — report it with this line.',
      cause
    );
  }
}
