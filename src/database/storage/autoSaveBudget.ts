/**
 * Write budget for the SQLite cache auto-save.
 *
 * `saveToFile()` serializes the whole database on every tick — there is no
 * delta write — so the cost of a save is proportional to the size of the
 * database, while a fixed period is blind to it. On a large vault that
 * combination is pathological: any SQL write marks the cache dirty (`exec`,
 * `run` and `commit` all do), so a 30s period rewrites the entire database
 * twice a minute for as long as the plugin is being used at all.
 *
 * Measured on a 43k-note vault with a 146 MB cache: macOS filed a resource
 * diagnostic for 34.36 GB written over 11.4 hours — 835 KB/s sustained against
 * the system's own 397 KB/s threshold. Not disk space: the same database
 * rewritten roughly 240 times.
 *
 * So the period is derived from a write budget instead of being fixed. Two
 * bounds keep it honest at the extremes:
 *
 * - the floor preserves today's behaviour for small caches, where a save is
 *   cheap and freshness is worth more than the bytes;
 * - the ceiling bounds how much cache a crash can cost. `close()` saves on a
 *   clean shutdown, but a crash skips it, so the ceiling is the real exposure.
 *   The cache is rebuildable from the JSONL event store, so this is replay
 *   time, not data loss.
 *
 * Above roughly 60 MB the ceiling dominates and the budget stops binding —
 * deliberately. Bounding crash exposure outranks shaving writes.
 */

/** Target sustained write rate, in bytes per second. */
export const AUTO_SAVE_TARGET_BYTES_PER_SECOND = 100 * 1024;

/** Never save more often than this. */
export const AUTO_SAVE_MIN_INTERVAL_MS = 30_000;

/** Never let a crash cost more than this much cache. */
export const AUTO_SAVE_MAX_INTERVAL_MS = 10 * 60_000;

export interface AutoSaveBudgetBounds {
  targetBytesPerSecond?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

/**
 * Interval at which a database of `sizeBytes` can be rewritten without
 * exceeding the target write rate, clamped to the bounds above.
 *
 * A non-finite or non-positive size means we have no basis to judge — the
 * PRAGMA failed, or the database is not open yet — and the floor is returned
 * rather than a guess, so an unreadable size can never widen the interval.
 */
export function computeAutoSaveIntervalMs(
  sizeBytes: number,
  bounds: AutoSaveBudgetBounds = {}
): number {
  const target = bounds.targetBytesPerSecond ?? AUTO_SAVE_TARGET_BYTES_PER_SECOND;
  const min = bounds.minIntervalMs ?? AUTO_SAVE_MIN_INTERVAL_MS;
  const max = bounds.maxIntervalMs ?? AUTO_SAVE_MAX_INTERVAL_MS;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return min;
  }

  const budgeted = (sizeBytes / target) * 1000;
  return Math.min(max, Math.max(min, Math.round(budgeted)));
}
