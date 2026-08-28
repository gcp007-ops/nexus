/**
 * What each save actually cost, written down where it can be read later.
 *
 * The VFS counts its own `xWrite` calls, and until this existed the count was
 * discarded along with the object that held it: the one number this whole change
 * is about was computed and thrown away. Answering "did the writes actually go
 * down?" then meant reconstructing it from macOS per-process I/O accounting,
 * which cannot separate the cache from everything else the renderer writes and
 * so can only bound it from above.
 *
 * The sampling point is every `saveDatabase()`, and it is chosen rather than
 * convenient: both backends are reached from the same seven call sites in
 * `SQLiteCacheManager`, so whatever asked for a save here would have asked for
 * a whole-database export there. That is what makes `wouldHaveWrittenBytes` the
 * size of the database rather than an estimate — `sqlite3_js_db_export()`
 * produces the on-disk image byte for byte, which is the same fact that lets a
 * blob seed a file by copying instead of converting.
 *
 * Worth knowing which of those call sites dominates, because it is not the one
 * the auto-save budget was built for. The tick and the save on close are gated
 * on `hasUnsavedData`; the public `save()` is not, and it is called after every
 * sync batch and — through `IndexingQueue`, `ConversationIndexer` and
 * `TraceIndexer` — on every tenth item embedded. On the blob path that is a
 * full export per ten embeddings, which the budget never bounded because the
 * budget only paces the tick. It is why the counters here can show a database
 * written a hundred times over in a session that ticked twice.
 *
 * Two things the counters deliberately do not include. Seeding writes the file
 * with `fs.writeFileSync`, around the VFS rather than through it, so a first
 * launch does not book its 200-odd MB here — these are SQLite's writes, not the
 * file's whole history. And the rollback journal is written through the VFS, so
 * it *is* counted; a save costs the pages plus the journal that protected them,
 * which is the honest figure to compare against an export.
 *
 * Every derived field is reproducible from the measured fields in the same
 * record, so a reader never has to trust arithmetic done here.
 */

/** Bumped when the shape of a record changes, so an old file stays readable. */
export const CACHE_WRITE_STATS_SCHEMA = 1;

/**
 * Trim the file once it passes this, keeping the most recent half.
 *
 * At one record per save and a save at most every thirty minutes, this is years
 * of history — the cap exists so an unattended vault cannot grow a log without
 * bound, not because the volume is expected to matter.
 */
export const STATS_FILE_MAX_BYTES = 512 * 1024;

/** The subset of `NodeFsVfsStats` a record is built from. */
export interface CacheWriteCounters {
  writeCalls: number;
  bytesWritten: number;
  readCalls: number;
  bytesRead: number;
  syncs: number;
  truncates: number;
}

export interface CacheWriteStatsRecord {
  schema: number;
  /** ISO-8601, UTC. */
  at: string;
  /** Since the VFS mounted. */
  uptimeMs: number;
  /** Since the previous record, so a rate can be computed without adjacency. */
  sinceLastMs: number;
  dbSizeBytes: number;

  /** Measured, since the previous record. */
  bytesWritten: number;
  writeCalls: number;
  bytesRead: number;
  readCalls: number;
  syncs: number;
  truncates: number;

  /**
   * What the blob-backed path would have written at this same instant.
   *
   * Equal to the database size by construction, not by approximation — see the
   * module comment.
   */
  wouldHaveWrittenBytes: number;
  /** `wouldHaveWrittenBytes - bytesWritten`. Negative is possible and is real. */
  avoidedBytes: number;
  /**
   * `wouldHaveWrittenBytes / bytesWritten`, to one decimal.
   *
   * Null when nothing was written, because the ratio is undefined there and a
   * placeholder number would be indistinguishable from a measured one.
   */
  timesSmallerThanExport: number | null;

  /** Since the VFS mounted, so a session can be read from its last line alone. */
  cumulativeBytesWritten: number;
  cumulativeWouldHaveWrittenBytes: number;
}

/** The slice of `node:fs` this needs, so the recorder can be tested without one. */
export interface StatsFileSystem {
  statSync(path: string): { size: number };
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}

const EMPTY_COUNTERS: CacheWriteCounters = {
  writeCalls: 0, bytesWritten: 0, readCalls: 0, bytesRead: 0, syncs: 0, truncates: 0
};

/**
 * Turns cumulative VFS counters into per-save records and appends them.
 *
 * Holds the previous sample because the counters are cumulative and what is
 * worth reading is the delta; holds the counterfactual total because it is the
 * only figure that cannot be recovered from the counters after the fact.
 */
export class CacheWriteStatsRecorder {
  private readonly startedAtMs: number;
  private lastAtMs: number;
  private lastCounters: CacheWriteCounters;
  private cumulativeWouldHaveWritten = 0;
  private latest: CacheWriteStatsRecord | null = null;
  private reportedFailure = false;

  constructor(
    private readonly filePath: string,
    nowMs: number,
    counters: CacheWriteCounters = EMPTY_COUNTERS
  ) {
    this.startedAtMs = nowMs;
    this.lastAtMs = nowMs;
    this.lastCounters = { ...counters };
  }

  /** Build the record for this save and advance the marks. Pure. */
  build(nowMs: number, counters: CacheWriteCounters, dbSizeBytes: number): CacheWriteStatsRecord {
    const bytesWritten = counters.bytesWritten - this.lastCounters.bytesWritten;
    this.cumulativeWouldHaveWritten += dbSizeBytes;

    const record: CacheWriteStatsRecord = {
      schema: CACHE_WRITE_STATS_SCHEMA,
      at: new Date(nowMs).toISOString(),
      uptimeMs: nowMs - this.startedAtMs,
      sinceLastMs: nowMs - this.lastAtMs,
      dbSizeBytes,

      bytesWritten,
      writeCalls: counters.writeCalls - this.lastCounters.writeCalls,
      bytesRead: counters.bytesRead - this.lastCounters.bytesRead,
      readCalls: counters.readCalls - this.lastCounters.readCalls,
      syncs: counters.syncs - this.lastCounters.syncs,
      truncates: counters.truncates - this.lastCounters.truncates,

      wouldHaveWrittenBytes: dbSizeBytes,
      avoidedBytes: dbSizeBytes - bytesWritten,
      timesSmallerThanExport: bytesWritten > 0
        ? Math.round((dbSizeBytes / bytesWritten) * 10) / 10
        : null,

      cumulativeBytesWritten: counters.bytesWritten,
      cumulativeWouldHaveWrittenBytes: this.cumulativeWouldHaveWritten
    };

    this.lastAtMs = nowMs;
    this.lastCounters = { ...counters };
    this.latest = record;
    return record;
  }

  /** The most recent record, for a caller that wants it without reading the file. */
  getLatest(): CacheWriteStatsRecord | null {
    return this.latest;
  }

  /**
   * Append one record.
   *
   * Never throws, and never lets a statistics failure reach the caller: this is
   * called from the save path, and a save reported as failed because a log line
   * could not be written would be a regression caused by the instrumentation.
   * It warns once per session rather than per save, because a full disk would
   * otherwise turn one problem into a console flood.
   */
  append(fs: StatsFileSystem, record: CacheWriteStatsRecord): void {
    try {
      this.trimIfOversized(fs);
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        console.warn(
          `[CacheWriteStats] Could not write ${this.filePath}; the cache is unaffected and ` +
          'this is the only warning for this session.',
          error
        );
      }
    }
  }

  private trimIfOversized(fs: StatsFileSystem): void {
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      // No file yet. Appending creates it.
      return;
    }
    if (size <= STATS_FILE_MAX_BYTES) {
      return;
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(line => line.length > 0);
    const kept = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(this.filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  }
}
