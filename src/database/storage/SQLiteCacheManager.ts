/**
 * Location: src/database/storage/SQLiteCacheManager.ts
 * Purpose: SQLite cache manager using @dao-xyz/sqlite3-vec WASM for hybrid storage system
 *
 * Provides:
 * - Local cache for fast queries and true pagination
 * - Native vector search via sqlite-vec (compiled into WASM)
 * - Manual file persistence via serialize/deserialize (Obsidian Sync compatible)
 * - Full-text search via FTS4
 * - Transaction support
 * - Event tracking to prevent duplicate processing
 *
 * Relationships:
 * - Used by StorageManager for fast queries
 * - Backed by JSONL files in EventLogManager
 * - Implements IStorageBackend interface
 *
 * Architecture Notes:
 * - Uses WASM build of SQLite with sqlite-vec statically compiled
 * - In-memory database with manual file persistence
 * - sqlite3_js_db_export() to serialize, sqlite3_deserialize() to load
 * - Works in Electron renderer (no native bindings)
 */

import { App } from 'obsidian';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { IStorageBackend, RunResult, DatabaseStats } from '../interfaces/IStorageBackend';
import type { SyncState, ISQLiteCacheManager } from '../sync/SyncCoordinator';
import { SQLiteSearchService } from './SQLiteSearchService';
import { QueryParams } from '../repositories/base/BaseRepository';
import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';
import { SQLiteTransactionCoordinator } from './SQLiteTransactionCoordinator';
import { SQLiteSyncStateStore } from './SQLiteSyncStateStore';
import { SQLitePersistenceService } from './SQLitePersistenceService';
import { SQLiteMaintenanceService, SQLiteMaintenanceStatistics } from './SQLiteMaintenanceService';
import type { CacheBlobStore } from './CacheBlobStore';
import { createCacheBlobStore, computeIdbKey } from './CacheBlobStoreFactory';
import { resolveActivePluginFolderName } from './PluginStoragePathResolver';

// Import schema from TypeScript module (esbuild compatible)
import { SCHEMA_SQL } from '../schema/schema';
import { SchemaMigrator } from '../schema/SchemaMigrator';
import { computeAutoSaveIntervalMs } from './autoSaveBudget';

import type { Plugin } from 'obsidian';

export interface SQLiteCacheManagerOptions {
  app: App;
  dbPath: string;  // plugin-scoped cache path used by VaultAdapter backend on mobile
  wasmPath?: string;
  autoSaveInterval?: number;  // ms between auto-saves (default: 30000)
  /**
   * Plugin used to compute the IDB key (manifest dir). Required when
   * `blobStore` is omitted so the factory can build the desktop store with a
   * stable per-install key. Tests can pass a pre-built `blobStore` instead.
   */
  plugin?: Plugin;
  /**
   * Pre-built backing store. When provided, the cache manager uses it directly
   * instead of constructing one via the factory. Also enables migration code
   * in HybridStorageAdapter to share the same store instance.
   */
  blobStore?: CacheBlobStore;
}

export interface QueryResult<T> {
  items: T[];
  totalCount?: number;
}

/**
 * Database adapter that wraps raw WASM SQLite database to provide
 * exec() and run() methods for MigratableDatabase interface.
 */
class DatabaseAdapter {
  constructor(
    private readonly bridge: SQLiteWasmBridge,
    private readonly rawDb: SQLiteDatabaseHandle
  ) {}

  exec(sql: string): { values: unknown[][] }[] {
    const results = this.bridge.collectValues(this.rawDb, sql);
    return results.length > 0 ? [{ values: results }] : [];
  }

  run(sql: string, params?: QueryParams): void {
    this.bridge.executeStatement(this.rawDb, sql, params);
  }
}

/**
 * SQLite cache manager using @dao-xyz/sqlite3-vec WASM
 *
 * Features:
 * - SQLite + sqlite-vec via WASM (no native bindings)
 * - Manual file persistence via serialize/deserialize
 * - Native vector search for embeddings
 * - Full-text search with FTS4
 * - Cursor-based pagination
 * - Transaction support
 */
export class SQLiteCacheManager implements IStorageBackend, ISQLiteCacheManager {
  private app: App;
  private dbPath: string;  // Relative path within vault
  private wasmPath?: string;
  private readonly bridge: SQLiteWasmBridge;
  private sqlite3: SQLiteWasmModule | null = null;  // The sqlite3 WASM module
  private db: SQLiteDatabaseHandle | null = null;  // The oo1.DB instance
  private isInitialized = false;
  private searchService: SQLiteSearchService;
  private hasUnsavedData = false;
  private autoSaveInterval: number;
  private autoSaveTimer: number | null = null;
  private warnedUnreadableDbSize = false;
  private readonly transactionCoordinator: SQLiteTransactionCoordinator;
  private readonly syncStateStore: SQLiteSyncStateStore;
  private readonly persistenceService: SQLitePersistenceService;
  private readonly blobStore: CacheBlobStore;
  private maintenanceService?: SQLiteMaintenanceService;

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.wasmPath = options.wasmPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;  // 30 seconds default
    this.bridge = new SQLiteWasmBridge();
    this.transactionCoordinator = new SQLiteTransactionCoordinator();
    this.blobStore = options.blobStore ?? this.buildDefaultBlobStore(options);
    this.persistenceService = new SQLitePersistenceService({
      blobStore: this.blobStore,
      bridge: this.bridge
    });
    this.syncStateStore = new SQLiteSyncStateStore(
      <T>(sql: string, params?: QueryParams) => this.query<T>(sql, params),
      <T>(sql: string, params?: QueryParams) => this.queryOne<T>(sql, params),
      (sql: string, params?: QueryParams) => this.run(sql, params)
    );
    this.searchService = new SQLiteSearchService(this);
  }

  /**
   * Expose the underlying sync-state store so `ReconcilePipeline` can read
   * the cursor table directly. The store handles its own SQL; this getter
   * is the only seam the pipeline needs to touch SQLite.
   */
  getSyncStateStore(): SQLiteSyncStateStore {
    return this.syncStateStore;
  }

  /**
   * Expose the blob store so HybridStorageAdapter.rebuildCache() and the
   * migration runner can share the same instance the cache manager uses.
   */
  getBlobStore(): CacheBlobStore {
    return this.blobStore;
  }

  private buildDefaultBlobStore(options: SQLiteCacheManagerOptions): CacheBlobStore {
    const pluginDir = options.plugin
      ? resolveActivePluginFolderName(options.plugin)
      : 'nexus';
    return createCacheBlobStore({
      app: options.app,
      vaultRelativePath: options.dbPath,
      idbKey: computeIdbKey(options.app, pluginDir)
    });
  }

  /**
   * Update the database path before initialization.
   * Must be called before initialize() — has no effect after the DB is open.
   */
  setDbPath(path: string): void {
    if (this.isInitialized) {
      console.warn('[SQLiteCacheManager] setDbPath called after initialization — ignoring');
      return;
    }

    this.dbPath = path;
    // persistenceService no longer tracks path — owned by CacheBlobStore now.
    if (this.maintenanceService) {
      this.maintenanceService.setDbPath(path);
    }
  }

  private getMaintenanceService(): SQLiteMaintenanceService {
    if (!this.maintenanceService) {
      this.maintenanceService = new SQLiteMaintenanceService({
        app: this.app,
        dbPath: this.dbPath,
        bridge: this.bridge,
        getDb: () => this.getDbOrThrow(),
        queryOne: <T>(sql: string, params?: QueryParams) => this.queryOne<T>(sql, params),
        transaction: <T>(fn: () => Promise<T>) => this.transaction(fn),
        blobStore: this.blobStore
      });
    }
    return this.maintenanceService;
  }

  private getSqlite3OrThrow(): SQLiteWasmModule {
    if (!this.sqlite3) {
      throw new Error('SQLite module not initialized');
    }
    return this.sqlite3;
  }

  private getDbOrThrow(): SQLiteDatabaseHandle {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  /**
   * Resolve the sqlite3.wasm path for the currently-installed plugin folder.
   *
   * Nexus supports legacy installs under `.obsidian/plugins/claudesidian-mcp/`
   * as well as the current `.obsidian/plugins/nexus/` folder.
   */
  private async resolveSqliteWasmPath(): Promise<string> {
    if (this.wasmPath) {
      try {
        if (await this.app.vault.adapter.exists(this.wasmPath)) {
          return this.wasmPath;
        }
      } catch {
        // Fall through to legacy candidates.
      }
    }

    const configDir = this.app.vault.configDir;
    const candidatePluginFolders = ['nexus', 'claudesidian-mcp'];
    const candidates = candidatePluginFolders.map(folder => `${configDir}/plugins/${folder}/sqlite3.wasm`);

    for (const candidate of candidates) {
      try {
        if (await this.app.vault.adapter.exists(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore adapter errors and continue trying other candidates.
      }
    }
    throw new Error(
      `[SQLiteCacheManager] sqlite3.wasm not found. Looked in: ${candidates.join(', ')}`
    );
  }

  /**
   * Initialize sqlite3 WASM and create/open database
   * Uses in-memory database with manual file persistence
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Load WASM binary using Obsidian's vault adapter
      // The WASM file is copied to the plugin directory by esbuild
      const wasmPath = await this.resolveSqliteWasmPath();

      // Read WASM binary using Obsidian's API
      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

      const consoleRef = console;
      const originalWarn = consoleRef.warn;
      const originalLog = consoleRef.log;
      const suppressPatterns = [
        /OPFS sqlite3_vfs/,
        /Heap resize call/,
        /instantiateWasm/
      ];
      consoleRef.warn = (...args: unknown[]) => {
        const msg = args[0]?.toString() || '';
        if (!suppressPatterns.some(p => p.test(msg))) {
          originalWarn.apply(console, args);
        }
      };
      consoleRef.log = (...args: unknown[]) => {
        const msg = args[0]?.toString() || '';
        if (!suppressPatterns.some(p => p.test(msg))) {
          originalLog.apply(console, args);
        }
      };

      try {
        this.sqlite3 = await this.bridge.initializeModule(wasmBinary);
      } finally {
        consoleRef.warn = originalWarn;
        consoleRef.log = originalLog;
      }

      // Ensure parent directory exists. Required regardless of backend
      // because legacy migration reads/writes through this path on first
      // launch, and the VaultAdapter mobile backend writes here in steady
      // state. Cheap idempotent op when the dir is already present.
      const parentPath = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const parentExists = await this.app.vault.adapter.exists(parentPath);
      if (!parentExists) {
        await this.app.vault.adapter.mkdir(parentPath);
      }

      // Ask the blob store directly — getMetadata returns null when the blob
      // is absent. This works uniformly across IDB (desktop) and the
      // vault.adapter file path (mobile) without leaking which backend is in
      // use into the cache manager.
      const meta = await this.blobStore.getMetadata();
      const dbExists = meta !== null && meta.size > 0;

      if (dbExists) {
        // Load existing database from blob store
        await this.loadFromFile();
      } else {
        const sqlite3 = this.getSqlite3OrThrow();
        const db = this.persistenceService.createFreshDatabase(sqlite3, SCHEMA_SQL);
        this.db = db;
        await this.saveToFile();
      }

      // Run schema migrations for existing databases
      // Wrap raw database in adapter to provide exec() and run() methods
      const dbAdapter = new DatabaseAdapter(this.bridge, this.getDbOrThrow());
      const migrator = new SchemaMigrator(dbAdapter);
      const migrationResult = await migrator.migrate();
      if (migrationResult.applied > 0) {
        await this.saveToFile(); // Save after migrations
      }

      // Start auto-save. The delay is re-derived from the database size before
      // every tick rather than fixed, so a growing cache stretches the period
      // instead of multiplying the bytes written. See autoSaveBudget.ts.
      if (this.autoSaveInterval > 0) {
        this.scheduleNextAutoSave();
      }

      this.isInitialized = true;
    } catch (error) {
      console.error('[SQLiteCacheManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load database from file using sqlite3_deserialize
   * Includes corruption detection and auto-recovery
   */
  private async loadFromFile(): Promise<void> {
    const sqlite3 = this.getSqlite3OrThrow();
    this.db = await this.persistenceService.loadDatabase(sqlite3, SCHEMA_SQL);
    this.hasUnsavedData = false;
  }

  /**
   * Recreate database after corruption detected
   * Deletes corrupt file and creates fresh database
   */
  private async recreateCorruptedDatabase(): Promise<void> {
    const sqlite3 = this.getSqlite3OrThrow();
    if (this.db) {
      try {
        this.bridge.close(this.db);
      } catch {
        void 0;
      }
      this.db = null;
    }

    this.db = await this.persistenceService.recreateCorruptedDatabase(sqlite3, SCHEMA_SQL);
    this.hasUnsavedData = false;
  }

  /**
   * Save database to file using sqlite3_js_db_export
   */
  private async saveToFile(): Promise<void> {
    const db = this.getDbOrThrow();
    const sqlite3 = this.getSqlite3OrThrow();
    await this.persistenceService.saveDatabase(sqlite3, db);
    this.hasUnsavedData = false;
  }

  /**
   * On-disk size of the database, or 0 when it cannot be read.
   *
   * Returning 0 rather than a guess matters: `computeAutoSaveIntervalMs` treats
   * an unreadable size as "no basis to judge" and falls back to the floor, so a
   * failed PRAGMA can never silently widen the crash window.
   *
   * But falling back silently is its own trap: the floor *is* the old fixed
   * period, so a broken size read degrades into exactly the behaviour the
   * budget exists to replace, and looks identical from outside. Hence the warn
   * — once per manager, since this runs before every save and would otherwise
   * become its own noise problem.
   */
  private getDatabaseSizeBytes(): number {
    try {
      const bytes = this.getDbOrThrow().selectValue(
        'SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()'
      );
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) {
        return bytes;
      }
      this.warnUnreadableDbSizeOnce(`unexpected value: ${typeof bytes} ${String(bytes)}`);
      return 0;
    } catch (error) {
      this.warnUnreadableDbSizeOnce(error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  /**
   * Report an unreadable database size once, then stay quiet.
   *
   * Exposed for tests: the interesting property is that repeated failures do
   * not repeat the warning, and that is awkward to assert through a console
   * spy alone.
   */
  private warnUnreadableDbSizeOnce(reason: string): void {
    if (this.warnedUnreadableDbSize) {
      return;
    }
    this.warnedUnreadableDbSize = true;
    console.warn(
      '[SQLiteCacheManager] Could not read the database size, so the auto-save '
      + 'budget is inactive and the minimum interval applies. Saves will be as '
      + `frequent as before. Reason: ${reason}`
    );
  }

  /**
   * Arm the next auto-save tick, sizing the delay to the current database.
   *
   * A self-rescheduling timeout rather than an interval: the delay has to be
   * recomputed as the cache grows, and an interval fixes it at whatever the
   * size was when the plugin started.
   */
  private scheduleNextAutoSave(): void {
    if (this.autoSaveInterval <= 0) {
      return;
    }

    const delay = computeAutoSaveIntervalMs(this.getDatabaseSizeBytes());

    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      const done = this.hasUnsavedData
        ? this.saveToFile().catch(err => {
            console.error('[SQLiteCacheManager] Auto-save failed:', err);
          })
        : Promise.resolve();

      // Re-arm after the save settles, never before — otherwise a save slower
      // than the delay would stack overlapping full-database exports.
      void done.then(() => {
        if (this.isInitialized) {
          this.scheduleNextAutoSave();
        }
      });
    }, delay);
  }

  /**
   * Close the database and save to file
   */
  async close(): Promise<void> {
    try {
      // Stop auto-save. `isInitialized` is cleared first so a tick already in
      // flight does not re-arm behind us.
      this.isInitialized = false;
      if (this.autoSaveTimer) {
        window.clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = null;
      }

      // Final save
      if (this.hasUnsavedData) {
        await this.saveToFile();
      }

      if (this.db) {
        this.bridge.close(this.db);
        this.db = null;
      }
      this.isInitialized = false;
    } catch (error) {
      console.error('[SQLiteCacheManager] Error closing database:', error);
      throw error;
    }
  }

  /**
   * Execute raw SQL (for schema creation and multi-statement execution)
   * NOTE: Does not support parameters - use run() or query() for parameterized queries
   */
  exec(sql: string): Promise<void> {
    if (!this.db) return Promise.reject(new Error('Database not initialized'));

    try {
      this.bridge.exec(this.db, sql);
      this.hasUnsavedData = true;
      return Promise.resolve();
    } catch (error) {
      console.error('[SQLiteCacheManager] Exec failed:', error);
      throw error;
    }
  }

  /**
   * Query returning multiple rows
   */
  query<T>(sql: string, params?: QueryParams): Promise<T[]> {
    try {
      const results = this.bridge.query<T>(this.getDbOrThrow(), sql, params);
      return Promise.resolve(results);
    } catch (error) {
      console.error('[SQLiteCacheManager] Query failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Query returning single row
   */
  queryOne<T>(sql: string, params?: QueryParams): Promise<T | null> {
    try {
      const result = this.bridge.queryOne<T>(this.getDbOrThrow(), sql, params);
      return Promise.resolve(result);
    } catch (error) {
      console.error('[SQLiteCacheManager] QueryOne failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Run a statement (INSERT, UPDATE, DELETE)
   * Returns changes count and last insert rowid
   */
  run(sql: string, params?: QueryParams): Promise<RunResult> {
    try {
      const db = this.getDbOrThrow();
      const sqlite3 = this.getSqlite3OrThrow();
      const { changes, lastInsertRowid } = this.bridge.run(db, sqlite3, sql, params);

      this.hasUnsavedData = true;
      return Promise.resolve({ changes, lastInsertRowid });
    } catch (error) {
      console.error('[SQLiteCacheManager] Run failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Begin a transaction
   */
  beginTransaction(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'BEGIN TRANSACTION');
    return Promise.resolve();
  }

  /**
   * Commit a transaction
   */
  commit(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'COMMIT');
    this.hasUnsavedData = true;
    return Promise.resolve();
  }

  /**
   * Rollback a transaction
   */
  rollback(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'ROLLBACK');
    return Promise.resolve();
  }

  /**
   * Execute a function within a transaction
   * Serializes concurrent access through SQLiteTransactionCoordinator.
   * Nested calls are not supported; callers should keep one transaction boundary
   * around the complete operation instead of opening a transaction from inside one.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.transactionCoordinator.run(
      () => this.beginTransaction(),
      () => this.commit(),
      () => this.rollback(),
      fn
    );
  }

  // ==================== Higher-level query methods ====================

  /**
   * Get paginated results with offset-based pagination
   */
  async queryPaginated<T>(
    baseQuery: string,
    countQuery: string,
    options: PaginationParams = {},
    params: QueryParams = []
  ): Promise<PaginatedResult<T>> {
    const page = options.page ?? 0;
    const pageSize = Math.min(options.pageSize ?? 25, 200);
    const offset = page * pageSize;

    // Get total count
    const countResult = await this.queryOne<{ count: number }>(countQuery, params);
    const totalItems = countResult?.count ?? 0;
    const totalPages = Math.ceil(totalItems / pageSize);

    // Get paginated results
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const items = await this.query<T>(paginatedQuery, [...params, pageSize, offset]);

    return {
      items,
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages - 1,
      hasPreviousPage: page > 0
    };
  }

  // ==================== Event tracking ====================

  /**
   * Check if an event has already been applied
   */
  async isEventApplied(eventId: string): Promise<boolean> {
    return this.syncStateStore.isEventApplied(eventId);
  }

  /**
   * Mark an event as applied
   */
  async markEventApplied(eventId: string): Promise<void> {
    await this.syncStateStore.markEventApplied(eventId);
  }

  /**
   * Get list of applied event IDs after a timestamp
   */
  async getAppliedEventsAfter(timestamp: number): Promise<string[]> {
    return this.syncStateStore.getAppliedEventsAfter(timestamp);
  }

  // ==================== Sync state ====================

  /**
   * Get sync state for a device
   */
  async getSyncState(deviceId: string): Promise<SyncState | null> {
    return this.syncStateStore.getSyncState(deviceId);
  }

  /**
   * Update sync state for a device
   */
  async updateSyncState(deviceId: string, lastEventTimestamp: number, fileTimestamps: Record<string, number>): Promise<void> {
    await this.syncStateStore.updateSyncState(deviceId, lastEventTimestamp, fileTimestamps);
  }

  // ==================== Data management ====================

  async clearAllData(): Promise<void> {
    await this.getMaintenanceService().clearAllData();
  }

  async rebuildFTSIndexes(): Promise<void> {
    await this.getMaintenanceService().rebuildFTSIndexes();
  }

  async vacuum(): Promise<void> {
    await this.getMaintenanceService().vacuum();
    this.hasUnsavedData = true;
  }

  /**
   * Drop every note embedding and reclaim the space. Saves immediately rather
   * than waiting for the next auto-save tick — the point of the operation is
   * to shrink the file, and the budget-derived delay can be minutes.
   */
  async clearNoteEmbeddings(): Promise<void> {
    await this.getMaintenanceService().clearNoteEmbeddings();
    this.hasUnsavedData = true;
    await this.saveToFile();
  }

  // ==================== Full-text search ====================
  // Delegated to SQLiteSearchService for single responsibility

  /**
   * Search workspaces using FTS4
   */
  async searchWorkspaces(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchWorkspaces(query, limit);
  }

  /**
   * Search conversations using FTS4
   */
  async searchConversations(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchConversations(query, limit);
  }

  /**
   * Search messages using FTS4
   */
  async searchMessages(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchMessages(query, limit);
  }

  /**
   * Search messages within a specific conversation using FTS4
   */
  async searchMessagesInConversation(conversationId: string, query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchMessagesInConversation(conversationId, query, limit);
  }

  // ==================== Statistics ====================

  /**
   * Get database statistics
   */
  async getStatistics(): Promise<SQLiteMaintenanceStatistics> {
    return this.getMaintenanceService().getStatistics();
  }

  // ==================== Utilities ====================

  /**
   * Check if database is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * Get database path (relative)
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Force save to file
   */
  async save(): Promise<void> {
    await this.saveToFile();
  }

  /**
   * Stop the auto-save timer without closing the database. Used by the
   * Rebuild Cache flow to suspend writes before clearing the blob store.
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return this.hasUnsavedData;
  }

  // ==================== IStorageBackend interface methods ====================

  /**
   * Check if database is open and ready (IStorageBackend requirement)
   */
  isOpen(): boolean {
    return this.isReady();
  }

  /**
   * Get database path (IStorageBackend requirement)
   */
  getDatabasePath(): string | null {
    return this.dbPath;
  }

  /**
   * Get database statistics (IStorageBackend requirement)
   */
  async getStats(): Promise<DatabaseStats> {
    return this.getMaintenanceService().getStats();
  }
}
