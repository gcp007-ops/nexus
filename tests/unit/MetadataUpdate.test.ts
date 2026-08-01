/**
 * resolveMetadataUpdate Unit Tests
 *
 * Specifies the pure metadata update operation shared by TaskRepository and
 * ProjectRepository: shallow merge by default, explicit replacement, and
 * merge-mode key removal.
 *
 * These tests own the contract. The repositories are responsible only for
 * calling the resolver inside their transaction and persisting its result.
 */

import {
  resolveMetadataUpdate,
  MetadataUpdateOperation
} from '../../src/database/repositories/metadataUpdate';

describe('resolveMetadataUpdate', () => {
  // ==========================================================================
  // Default shallow merge
  // ==========================================================================

  describe('default merge mode', () => {
    it('preserves unrelated existing keys', () => {
      const result = resolveMetadataUpdate({
        current: { keep: 'me', other: 1 },
        metadata: { added: true }
      });

      expect(result).toEqual({ keep: 'me', other: 1, added: true });
    });

    it('overwrites the same top-level key', () => {
      const result = resolveMetadataUpdate({
        current: { status: 'old', keep: 'me' },
        metadata: { status: 'new' }
      });

      expect(result).toEqual({ status: 'new', keep: 'me' });
    });

    it('replaces nested objects instead of merging them recursively', () => {
      const result = resolveMetadataUpdate({
        current: { nested: { a: 1, b: 2 }, keep: 'me' },
        metadata: { nested: { b: 3 } }
      });

      expect(result).toEqual({ nested: { b: 3 }, keep: 'me' });
    });

    it('merges into an absent current object', () => {
      const result = resolveMetadataUpdate({ metadata: { a: 1 } });

      expect(result).toEqual({ a: 1 });
    });

    it('is the behavior when metadataMode is stated explicitly', () => {
      const result = resolveMetadataUpdate({
        current: { keep: 'me' },
        metadata: { added: true },
        metadataMode: 'merge'
      });

      expect(result).toEqual({ keep: 'me', added: true });
    });

    it('does not mutate the current or incoming objects', () => {
      const current = { keep: 'me' };
      const metadata = { added: true };

      resolveMetadataUpdate({ current, metadata });

      expect(current).toEqual({ keep: 'me' });
      expect(metadata).toEqual({ added: true });
    });

    it('returns an object that is not an alias of current or metadata', () => {
      const current = { keep: 'me' };
      const metadata = { added: true };

      const result = resolveMetadataUpdate({ current, metadata });

      expect(result).not.toBe(current);
      expect(result).not.toBe(metadata);
    });

    it('ignores explicitly undefined incoming values rather than deleting keys', () => {
      const result = resolveMetadataUpdate({
        current: { keep: 'me' },
        metadata: { keep: undefined, added: 1 } as Record<string, unknown>
      });

      expect(result).toEqual({ keep: 'me', added: 1 });
    });

    it('preserves falsy incoming values', () => {
      const result = resolveMetadataUpdate({
        current: { flag: true, count: 5, label: 'x' },
        metadata: { flag: false, count: 0, label: '' }
      });

      expect(result).toEqual({ flag: false, count: 0, label: '' });
    });

    it('preserves an explicit null incoming value', () => {
      const result = resolveMetadataUpdate({
        current: { hold: 'reason' },
        metadata: { hold: null }
      });

      expect(result).toEqual({ hold: null });
    });
  });

  // ==========================================================================
  // Explicit replacement
  // ==========================================================================

  describe('replace mode', () => {
    it('replaces the complete object', () => {
      const result = resolveMetadataUpdate({
        current: { a: 1, b: 2 },
        metadata: { c: 3 },
        metadataMode: 'replace'
      });

      expect(result).toEqual({ c: 3 });
    });

    it('clears all metadata when given an empty object', () => {
      const result = resolveMetadataUpdate({
        current: { a: 1 },
        metadata: {},
        metadataMode: 'replace'
      });

      expect(result).toEqual({});
    });

    it('throws when metadata is absent', () => {
      expect(() =>
        resolveMetadataUpdate({ current: { a: 1 }, metadataMode: 'replace' })
      ).toThrow(/metadata/);
    });

    it('does not mutate the incoming object', () => {
      const metadata = { c: 3 };

      const result = resolveMetadataUpdate({
        current: { a: 1 },
        metadata,
        metadataMode: 'replace'
      });

      expect(result).not.toBe(metadata);
      expect(metadata).toEqual({ c: 3 });
    });
  });

  // ==========================================================================
  // Removals
  // ==========================================================================

  describe('removeMetadataKeys', () => {
    it('removes requested keys after applying the merge patch', () => {
      const result = resolveMetadataUpdate({
        current: { stale: 'gone', keep: 'me' },
        metadata: { added: true },
        removeMetadataKeys: ['stale']
      });

      expect(result).toEqual({ keep: 'me', added: true });
    });

    it('removes a key the same request just merged in', () => {
      const result = resolveMetadataUpdate({
        current: { keep: 'me' },
        metadata: { temp: 1 },
        removeMetadataKeys: ['temp']
      });

      expect(result).toEqual({ keep: 'me' });
    });

    it('ignores keys that are absent when other work remains', () => {
      const result = resolveMetadataUpdate({
        current: { keep: 'me' },
        metadata: { added: true },
        removeMetadataKeys: ['neverThere']
      });

      expect(result).toEqual({ keep: 'me', added: true });
    });

    it('can produce an empty object that must be persisted', () => {
      const result = resolveMetadataUpdate({
        current: { only: 'key' },
        removeMetadataKeys: ['only']
      });

      expect(result).toEqual({});
    });

    it('works as a removal-only request', () => {
      const result = resolveMetadataUpdate({
        current: { a: 1, b: 2 },
        removeMetadataKeys: ['a']
      });

      expect(result).toEqual({ b: 2 });
    });

    it('rejects replace combined with removals', () => {
      expect(() =>
        resolveMetadataUpdate({
          current: { a: 1 },
          metadata: { c: 3 },
          metadataMode: 'replace',
          removeMetadataKeys: ['a']
        })
      ).toThrow(/removeMetadataKeys/);
    });

    it('accepts an empty removal array alongside replace, since it removes nothing', () => {
      const result = resolveMetadataUpdate({
        current: { a: 1 },
        metadata: { c: 3 },
        metadataMode: 'replace',
        removeMetadataKeys: []
      });

      expect(result).toEqual({ c: 3 });
    });
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  describe('validation', () => {
    it('rejects an unsupported mode', () => {
      expect(() =>
        resolveMetadataUpdate({
          metadata: { a: 1 },
          metadataMode: 'patch' as unknown as MetadataUpdateOperation['metadataMode']
        })
      ).toThrow(/metadataMode/);
    });

    it('rejects a non-array removeMetadataKeys', () => {
      expect(() =>
        resolveMetadataUpdate({
          current: { a: 1 },
          removeMetadataKeys: 'a' as unknown as string[]
        })
      ).toThrow(/removeMetadataKeys/);
    });

    it('rejects non-string removal keys', () => {
      expect(() =>
        resolveMetadataUpdate({
          current: { a: 1 },
          removeMetadataKeys: [42 as unknown as string]
        })
      ).toThrow(/removeMetadataKeys/);
    });

    it('rejects empty and whitespace-only removal keys', () => {
      expect(() =>
        resolveMetadataUpdate({ current: { a: 1 }, removeMetadataKeys: [''] })
      ).toThrow(/removeMetadataKeys/);

      expect(() =>
        resolveMetadataUpdate({ current: { a: 1 }, removeMetadataKeys: ['   '] })
      ).toThrow(/removeMetadataKeys/);
    });

    it('rejects a non-object metadata patch', () => {
      expect(() =>
        resolveMetadataUpdate({
          metadata: 'nope' as unknown as Record<string, unknown>
        })
      ).toThrow(/metadata/);

      expect(() =>
        resolveMetadataUpdate({
          metadata: [1, 2] as unknown as Record<string, unknown>
        })
      ).toThrow(/metadata/);
    });
  });

  // ==========================================================================
  // No-op detection
  // ==========================================================================

  describe('no-op detection', () => {
    it('returns undefined when no patch and no removals are supplied', () => {
      expect(resolveMetadataUpdate({ current: { a: 1 } })).toBeUndefined();
    });

    it('returns undefined for an empty merge patch with no removals', () => {
      expect(
        resolveMetadataUpdate({ current: { a: 1 }, metadata: {} })
      ).toBeUndefined();
    });

    it('returns undefined for an empty merge patch with an empty removal array', () => {
      expect(
        resolveMetadataUpdate({
          current: { a: 1 },
          metadata: {},
          removeMetadataKeys: []
        })
      ).toBeUndefined();
    });

    it('returns undefined when a removal-only request names no existing key', () => {
      expect(
        resolveMetadataUpdate({
          current: { a: 1 },
          removeMetadataKeys: ['neverThere']
        })
      ).toBeUndefined();
    });

    it('returns undefined for a removal-only request against absent metadata', () => {
      expect(
        resolveMetadataUpdate({ removeMetadataKeys: ['anything'] })
      ).toBeUndefined();
    });

    it('returns undefined when the patch carries only undefined values', () => {
      expect(
        resolveMetadataUpdate({
          current: { a: 1 },
          metadata: { b: undefined } as Record<string, unknown>
        })
      ).toBeUndefined();
    });

    it('still returns a value when a removal names an existing key', () => {
      expect(
        resolveMetadataUpdate({
          current: { a: 1 },
          metadata: {},
          removeMetadataKeys: ['a']
        })
      ).toEqual({});
    });
  });
});
