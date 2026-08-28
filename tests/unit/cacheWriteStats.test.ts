/**
 * The record that says whether the change worked.
 *
 * What is asserted here is that the arithmetic in a record is the arithmetic a
 * reader would do from the same record's own fields, that an undefined ratio is
 * reported as undefined rather than as a number, and that instrumentation can
 * fail without taking a save down with it. The last one is the important one:
 * this runs on the save path, and a statistics file that cannot be written must
 * never be reported to the user as a cache that could not be saved.
 */

import {
  CacheWriteStatsRecorder,
  STATS_FILE_MAX_BYTES,
  type CacheWriteCounters,
  type StatsFileSystem
} from '../../src/database/storage/vfs/cacheWriteStats';

const PATH = '/app-data/vault/write-stats.jsonl';
const T0 = 1_700_000_000_000;

function counters(over: Partial<CacheWriteCounters> = {}): CacheWriteCounters {
  return { writeCalls: 0, bytesWritten: 0, readCalls: 0, bytesRead: 0, syncs: 0, truncates: 0, ...over };
}

function fakeFs(initial: string | null = null) {
  const state = { content: initial };
  const fs: StatsFileSystem & { state: { content: string | null } } = {
    state,
    statSync: jest.fn((_p: string) => {
      if (state.content === null) throw new Error('ENOENT');
      return { size: state.content.length };
    }),
    readFileSync: jest.fn(() => state.content ?? ''),
    writeFileSync: jest.fn((_p: string, data: string) => { state.content = data; }),
    appendFileSync: jest.fn((_p: string, data: string) => { state.content = (state.content ?? '') + data; })
  };
  return fs;
}

describe('build', () => {
  it('reports deltas, not the cumulative counters it is given', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0, counters({ bytesWritten: 1000, writeCalls: 5 }));

    const record = r.build(T0 + 30_000, counters({ bytesWritten: 1500, writeCalls: 8 }), 200_000);

    expect(record.bytesWritten).toBe(500);
    expect(record.writeCalls).toBe(3);
    expect(record.sinceLastMs).toBe(30_000);
    expect(record.cumulativeBytesWritten).toBe(1500);
  });

  it('states the counterfactual as the database size, which is what an export writes', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0);

    const record = r.build(T0 + 1000, counters({ bytesWritten: 8192 }), 232_816_640);

    expect(record.wouldHaveWrittenBytes).toBe(232_816_640);
    expect(record.avoidedBytes).toBe(232_816_640 - 8192);
    expect(record.timesSmallerThanExport).toBe(28420);
  });

  it('reproduces its own derived fields from its own measured fields', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0);

    const record = r.build(T0 + 1000, counters({ bytesWritten: 4096 }), 40_960);

    expect(record.avoidedBytes).toBe(record.wouldHaveWrittenBytes - record.bytesWritten);
    expect(record.timesSmallerThanExport)
      .toBe(Math.round((record.wouldHaveWrittenBytes / record.bytesWritten) * 10) / 10);
  });

  it('leaves the ratio null when nothing was written, rather than inventing one', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0);

    const record = r.build(T0 + 1000, counters({ bytesWritten: 0 }), 1024);

    expect(record.timesSmallerThanExport).toBeNull();
    expect(record.avoidedBytes).toBe(1024);
  });

  it('accumulates the counterfactual across saves, because no later reader can', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0);

    r.build(T0 + 1000, counters({ bytesWritten: 100 }), 1000);
    const second = r.build(T0 + 2000, counters({ bytesWritten: 250 }), 1000);

    expect(second.bytesWritten).toBe(150);
    expect(second.cumulativeWouldHaveWrittenBytes).toBe(2000);
  });

  it('exposes the latest record without touching the filesystem', () => {
    const r = new CacheWriteStatsRecorder(PATH, T0);
    expect(r.getLatest()).toBeNull();

    const record = r.build(T0 + 1000, counters({ bytesWritten: 8 }), 16);

    expect(r.getLatest()).toBe(record);
  });
});

describe('append', () => {
  it('writes one JSON object per line', () => {
    const fs = fakeFs();
    const r = new CacheWriteStatsRecorder(PATH, T0);

    r.append(fs, r.build(T0 + 1000, counters({ bytesWritten: 8 }), 16));
    r.append(fs, r.build(T0 + 2000, counters({ bytesWritten: 24 }), 16));

    const lines = (fs.state.content ?? '').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).bytesWritten).toBe(16);
  });

  it('creates the file when there is none, instead of treating ENOENT as a failure', () => {
    const fs = fakeFs(null);
    const r = new CacheWriteStatsRecorder(PATH, T0);

    r.append(fs, r.build(T0 + 1000, counters({ bytesWritten: 8 }), 16));

    expect(fs.appendFileSync).toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('keeps the recent half once the file passes the cap', () => {
    const fs = fakeFs(`${'x'.repeat(STATS_FILE_MAX_BYTES + 1)}\ny\nz\nw\n`);
    const r = new CacheWriteStatsRecorder(PATH, T0);

    r.append(fs, r.build(T0 + 1000, counters({ bytesWritten: 8 }), 16));

    const lines = (fs.state.content ?? '').split('\n').filter(Boolean);
    expect(lines.slice(0, 2)).toEqual(['z', 'w']);
    expect(lines).toHaveLength(3);
  });

  it('swallows a filesystem failure and warns exactly once for the session', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fs = fakeFs();
    fs.appendFileSync = jest.fn(() => { throw new Error('ENOSPC'); });
    const r = new CacheWriteStatsRecorder(PATH, T0);

    expect(() => {
      r.append(fs, r.build(T0 + 1000, counters({ bytesWritten: 8 }), 16));
      r.append(fs, r.build(T0 + 2000, counters({ bytesWritten: 16 }), 16));
    }).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
