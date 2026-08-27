/**
 * The auto-save period is derived from a write budget rather than fixed.
 *
 * Context, because the numbers here are not arbitrary: `saveToFile()`
 * serializes the entire database every tick, and any SQL write marks the cache
 * dirty, so a fixed 30s period rewrites the whole database twice a minute for
 * as long as the plugin is used. On a 146 MB cache that produced 34.36 GB of
 * writes in 11.4 hours — 835 KB/s against the 397 KB/s the OS is willing to
 * tolerate.
 */

import {
  computeAutoSaveIntervalMs,
  AUTO_SAVE_MIN_INTERVAL_MS,
  AUTO_SAVE_MAX_INTERVAL_MS,
  AUTO_SAVE_TARGET_BYTES_PER_SECOND
} from '../../src/database/storage/autoSaveBudget';

const MB = 1024 * 1024;

/** Sustained write rate implied by rewriting `sizeBytes` every `intervalMs`. */
function impliedBytesPerSecond(sizeBytes: number, intervalMs: number): number {
  return sizeBytes / (intervalMs / 1000);
}

describe('auto-save write budget', () => {
  it('leaves a small cache on the existing 30s cadence', () => {
    // 1 MB against a 100 KB/s budget wants ~10s, which the floor lifts to 30s.
    expect(computeAutoSaveIntervalMs(1 * MB)).toBe(AUTO_SAVE_MIN_INTERVAL_MS);
  });

  it('stretches the interval as the cache grows', () => {
    const small = computeAutoSaveIntervalMs(10 * MB);
    const medium = computeAutoSaveIntervalMs(30 * MB);
    const large = computeAutoSaveIntervalMs(50 * MB);

    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
  });

  it('honours the budget in the range where neither bound binds', () => {
    // 30 MB / 100 KB/s = 307s, comfortably between the 30s floor and 30m ceiling.
    const interval = computeAutoSaveIntervalMs(30 * MB);

    expect(interval).toBeGreaterThan(AUTO_SAVE_MIN_INTERVAL_MS);
    expect(interval).toBeLessThan(AUTO_SAVE_MAX_INTERVAL_MS);
    expect(impliedBytesPerSecond(30 * MB, interval)).toBeCloseTo(
      AUTO_SAVE_TARGET_BYTES_PER_SECOND,
      -2
    );
  });

  it('caps the interval so a crash cannot cost more than the ceiling', () => {
    // The ceiling binds above ~176 MB (30m x 100 KB/s).
    expect(computeAutoSaveIntervalMs(200 * MB)).toBe(AUTO_SAVE_MAX_INTERVAL_MS);
    expect(computeAutoSaveIntervalMs(2000 * MB)).toBe(AUTO_SAVE_MAX_INTERVAL_MS);
  });

  it('holds the target at the size that made the ceiling move', () => {
    // Measured 2026-08-27: 96.8 MB rewritten every 601s = 161 kB/s, because a
    // 10m ceiling clamped a budget that wanted 945s. The point of raising it is
    // that this size is once again governed by the budget, not by the bound.
    const measured = 96_785_297;
    const interval = computeAutoSaveIntervalMs(measured);

    expect(interval).toBeLessThan(AUTO_SAVE_MAX_INTERVAL_MS);
    expect(impliedBytesPerSecond(measured, interval)).toBeCloseTo(
      AUTO_SAVE_TARGET_BYTES_PER_SECOND,
      -2
    );
  });

  it('keeps the measured vault under the rate the OS complained about', () => {
    // The diagnostic fired at 835 KB/s against a 397 KB/s limit.
    const withOrphanedVectors = impliedBytesPerSecond(
      146 * MB,
      computeAutoSaveIntervalMs(146 * MB)
    );
    const afterClearingVectors = impliedBytesPerSecond(
      83 * MB,
      computeAutoSaveIntervalMs(83 * MB)
    );

    expect(withOrphanedVectors).toBeLessThan(397 * 1024);
    expect(afterClearingVectors).toBeLessThan(397 * 1024);
  });

  it('falls back to the floor when the size cannot be read', () => {
    // An unreadable size must never widen the interval — that would turn a
    // failed PRAGMA into a silent extension of the crash window.
    expect(computeAutoSaveIntervalMs(0)).toBe(AUTO_SAVE_MIN_INTERVAL_MS);
    expect(computeAutoSaveIntervalMs(-1)).toBe(AUTO_SAVE_MIN_INTERVAL_MS);
    expect(computeAutoSaveIntervalMs(Number.NaN)).toBe(AUTO_SAVE_MIN_INTERVAL_MS);
    expect(computeAutoSaveIntervalMs(Number.POSITIVE_INFINITY)).toBe(AUTO_SAVE_MIN_INTERVAL_MS);
  });

  it('respects explicitly supplied bounds', () => {
    const interval = computeAutoSaveIntervalMs(10 * MB, {
      targetBytesPerSecond: 1024 * 1024,
      minIntervalMs: 1_000,
      maxIntervalMs: 60_000
    });

    expect(interval).toBe(10_000);
  });
});
