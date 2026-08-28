/**
 * Select how the cache is persisted, and fall back rather than fail.
 *
 * Mirrors `CacheBlobStoreFactory`: the platform decides, tests can override, and
 * production callers pass nothing. The difference is that this one can decline.
 * Mounting a VFS depends on things a compile-time check cannot see — a Node
 * runtime in the renderer, a writable directory, an `installVfs` that this
 * particular WASM build accepts — so every failure here returns null and the
 * caller keeps the blob-backed service it already had. The old path stays whole;
 * that is a stated condition of this work, not a nicety.
 */

import type { CachePersistence } from './CachePersistence';
import type { CacheBlobStore } from './CacheBlobStore';
import type { SQLiteWasmBridge, SQLiteWasmModule } from './SQLiteWasmBridge';
import { VfsPersistenceService } from './VfsPersistenceService';
import { installNodeFsVfs, SQLiteVfsCapableModule } from './vfs/nodeFsVfs';
import { resolveCacheFileLocation } from './vfs/cacheFileLocation';
import { desktopRequire } from '../../utils/desktopRequire';
import { isDesktop } from '../../utils/platform';

const VFS_NAME = 'nexus-nodefs';

export interface VfsPersistenceAttempt {
  sqlite3: SQLiteWasmModule;
  bridge: SQLiteWasmBridge;
  /** Stable per-vault key, from `computeIdbKey`. Becomes the directory name. */
  vaultKey: string;
  /** Existing blob store, read once to seed the file on the first run. */
  seedSource?: CacheBlobStore;
  /** Override platform selection for tests. Production leaves it undefined. */
  forceDesktop?: boolean;
}

/**
 * Build the VFS-backed persistence service, or return null with a reason logged.
 *
 * Returning null is an ordinary outcome, not an error: on mobile it is the only
 * correct one.
 */
export function tryCreateVfsPersistence(attempt: VfsPersistenceAttempt): CachePersistence | null {
  const useDesktop = attempt.forceDesktop ?? isDesktop();
  if (!useDesktop) {
    return null;
  }

  try {
    const location = resolveCacheFileLocation(attempt.vaultKey);

    const fs = desktopRequire<typeof import('node:fs')>('node:fs');
    fs.mkdirSync(location.dir, { recursive: true });

    installNodeFsVfs(attempt.sqlite3 as unknown as SQLiteVfsCapableModule, {
      vfsName: VFS_NAME,
      root: location.dir
    });

    return new VfsPersistenceService({
      bridge: attempt.bridge,
      filePath: location.file,
      vfsName: VFS_NAME,
      seedSource: attempt.seedSource
    });
  } catch (error) {
    // Loud on purpose. Falling back is safe, but falling back silently would
    // make "the VFS never mounted" indistinguishable from "the VFS mounted and
    // did nothing for the write volume" — and only one of those is a bug in the
    // VFS.
    console.warn(
      '[CachePersistenceFactory] Could not mount the node:fs VFS, so the cache stays on the ' +
      'existing blob store and keeps exporting the whole database on each save. ' +
      `Reason: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
    return null;
  }
}
