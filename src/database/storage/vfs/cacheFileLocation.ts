/**
 * Where the VFS-backed cache file lives.
 *
 * Outside the vault, always. Not a detail of implementation: the cache reached
 * 99 MB in this vault, and anything inside the vault is synchronised — the
 * plugin folder included — so a cache file there would be pushed between
 * machines on every page write. It is also the wrong thing to sync at all. The
 * cache is derived state: the JSONL event store is the source of truth, each
 * machine rebuilds its own, and three machines legitimately disagree about what
 * they have indexed.
 *
 * The root follows the OS convention for application data, so a user's own
 * backups pick it up (or skip it) by the same rule they apply to every other
 * app's cache, rather than by a rule this plugin invented.
 */

import { desktopRequire } from '../../../utils/desktopRequire';

/** Directory name under the platform's application-data root. */
const APP_DIR_NAME = 'nexus-cache';

/** File name inside the per-vault directory. */
const CACHE_FILE_NAME = 'cache.db';

/** Append-only record of what each save cost, beside the database it describes. */
const STATS_FILE_NAME = 'write-stats.jsonl';

export interface CacheFileLocation {
  /** Per-vault directory. Created by the caller, not here. */
  dir: string;
  /** Absolute path of the database file itself. */
  file: string;
  /**
   * Absolute path of the write-statistics record.
   *
   * Beside the database rather than in the vault, and for the same reason: it
   * describes one machine's cache, so it is not something three machines should
   * be reconciling. It also has to survive a rebuild of the cache to be worth
   * anything, which rules out living inside the file it measures.
   */
  statsFile: string;
}

interface PlatformEnvironment {
  platform: string;
  env: Record<string, string | undefined>;
  homedir: () => string;
}

/**
 * Reduce a vault key to something every filesystem accepts as one path segment.
 *
 * `computeIdbKey` returns `<appId>:<pluginFolder>`, and the colon alone makes it
 * illegal on Windows. Collapsing anything outside a conservative set keeps the
 * key stable and readable without having to know which filesystem is underneath.
 */
export function sanitiseVaultKey(vaultKey: string): string {
  const cleaned = vaultKey
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    // Trim the separators off the ends too. Without this a key of nothing but
    // unsafe characters collapses to "-" rather than to nothing, and the
    // emptiness guard below never fires — the cache would land in a directory
    // literally named "-".
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown-vault';
}

/**
 * Application-data root for the current platform.
 *
 * Exported for tests, which supply the environment rather than the real one —
 * asserting the Windows branch on macOS is otherwise impossible.
 */
export function resolveAppDataRoot(environment: PlatformEnvironment): string {
  const home = environment.homedir();

  if (environment.platform === 'darwin') {
    return `${home}/Library/Application Support/${APP_DIR_NAME}`;
  }

  if (environment.platform === 'win32') {
    const localAppData = environment.env.LOCALAPPDATA;
    const root = localAppData && localAppData.length > 0
      ? localAppData
      : `${home}\\AppData\\Local`;
    return `${root}\\${APP_DIR_NAME}`;
  }

  const xdgDataHome = environment.env.XDG_DATA_HOME;
  const root = xdgDataHome && xdgDataHome.length > 0
    ? xdgDataHome
    : `${home}/.local/share`;
  return `${root}/${APP_DIR_NAME}`;
}

/**
 * Full location for one vault's cache file.
 *
 * `environment` is injected only by tests. Production passes nothing and reads
 * the real platform — through `desktopRequire`, because a top-level import of
 * `node:os` in a module reachable from `main.ts` takes the plugin down at launch
 * on every phone. See scripts/check-mobile-imports.mjs.
 */
export function resolveCacheFileLocation(
  vaultKey: string,
  environment?: PlatformEnvironment
): CacheFileLocation {
  const resolved = environment ?? {
    platform: process.platform,
    env: process.env,
    homedir: desktopRequire<typeof import('node:os')>('node:os').homedir
  };

  const separator = resolved.platform === 'win32' ? '\\' : '/';
  const dir = `${resolveAppDataRoot(resolved)}${separator}${sanitiseVaultKey(vaultKey)}`;

  return {
    dir,
    file: `${dir}${separator}${CACHE_FILE_NAME}`,
    statsFile: `${dir}${separator}${STATS_FILE_NAME}`
  };
}
