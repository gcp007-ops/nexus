/**
 * tests/unit/SetPropertyMerge.test.ts — unit coverage for the pure merge
 * decision used by `SetPropertyTool.execute`.
 *
 * The tool runs the decision inside `fileManager.processFrontMatter`, but
 * `computeMergeResult` is a pure function of (existing, value), so each
 * branch can be asserted directly without an Obsidian App mock.
 *
 * Issue #172 added the scalar-into-array promotion branch. The rest of the
 * cases here are characterization of pre-#172 behavior, locked in so future
 * refactors don't silently alter merge semantics.
 */
import { computeMergeResult } from '../../src/agents/contentManager/tools/setProperty';

describe('computeMergeResult — merge-mode decision (SetPropertyTool, Issue #172)', () => {
  describe('missing-existing branch', () => {
    it('treats undefined existing as a replace with scalar value', () => {
      expect(computeMergeResult(undefined, 'tag-a')).toEqual({
        kind: 'replace',
        value: 'tag-a',
      });
    });

    it('treats null existing as a replace with scalar value', () => {
      expect(computeMergeResult(null, 42)).toEqual({
        kind: 'replace',
        value: 42,
      });
    });

    it('treats undefined existing as a replace with array value (no promotion needed)', () => {
      expect(computeMergeResult(undefined, ['a', 'b'])).toEqual({
        kind: 'replace',
        value: ['a', 'b'],
      });
    });
  });

  describe('string[] + string[] — union with dedup, order preserved', () => {
    it('unions two disjoint string arrays in existing-then-new order', () => {
      expect(computeMergeResult(['a', 'b'], ['c', 'd'])).toEqual({
        kind: 'replace',
        value: ['a', 'b', 'c', 'd'],
      });
    });

    it('drops items already present, keeps order stable', () => {
      // 'b' is duplicated; dedup preserves the existing-first ordering so the
      // second 'b' from `value` is skipped, not promoted to the end.
      expect(computeMergeResult(['a', 'b', 'c'], ['b', 'd', 'a'])).toEqual({
        kind: 'replace',
        value: ['a', 'b', 'c', 'd'],
      });
    });

    it('handles empty existing + non-empty new', () => {
      expect(computeMergeResult([], ['a'])).toEqual({
        kind: 'replace',
        value: ['a'],
      });
    });

    it('handles non-empty existing + empty new (no-op union)', () => {
      expect(computeMergeResult(['a', 'b'], [])).toEqual({
        kind: 'replace',
        value: ['a', 'b'],
      });
    });

    it('handles fully-overlapping input as a no-op', () => {
      expect(computeMergeResult(['a', 'b'], ['b', 'a'])).toEqual({
        kind: 'replace',
        value: ['a', 'b'],
      });
    });
  });

  describe('array existing + scalar new — #172 scalar-promote branch', () => {
    it('appends a new scalar string to an existing array', () => {
      expect(computeMergeResult(['a', 'b'], 'c')).toEqual({
        kind: 'replace',
        value: ['a', 'b', 'c'],
      });
    });

    it('skips a scalar already present (dedup)', () => {
      expect(computeMergeResult(['a', 'b'], 'b')).toEqual({
        kind: 'replace',
        value: ['a', 'b'],
      });
    });

    it('promotes onto an empty array (first-item case)', () => {
      expect(computeMergeResult([], 'first')).toEqual({
        kind: 'replace',
        value: ['first'],
      });
    });

    it('allows mixed-type append — number scalar onto string array', () => {
      // Intentional: frontmatter mixing is legal YAML, and strict-type
      // validation lives downstream. The merge helper's job is to preserve
      // the scalar-append operation without losing data.
      expect(computeMergeResult(['a', 'b'], 1)).toEqual({
        kind: 'replace',
        value: ['a', 'b', 1],
      });
    });

    it('appends onto an existing mixed-type array', () => {
      // The `!isStringArray` check on `existing` does NOT gate this branch,
      // so number[]/mixed[] also accept scalar appends. Locked in as a
      // deliberate relaxation from the string-only union path above.
      expect(computeMergeResult([1, 'two', 3], 'four')).toEqual({
        kind: 'replace',
        value: [1, 'two', 3, 'four'],
      });
    });

    it('skips duplicate non-string scalar (strict equality)', () => {
      expect(computeMergeResult([1, 2, 3], 2)).toEqual({
        kind: 'replace',
        value: [1, 2, 3],
      });
    });
  });

  describe('scalar existing + array new — error branch', () => {
    it('errors with a type-mismatch message', () => {
      const result = computeMergeResult('solo', ['a', 'b']);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.message).toMatch(/existing value is scalar/);
        expect(result.message).toMatch(/new value is array/);
        expect(result.message).toMatch(/mode "replace"/);
      }
    });

    it('errors even when existing scalar equals one of the new items (no upgrade path)', () => {
      // Semantically ambiguous: is the existing scalar one of the new items
      // or should it be discarded? Issue #172 deliberately scoped the fix to
      // scalar-into-array only; the inverse stays an explicit error.
      const result = computeMergeResult('a', ['a', 'b']);
      expect(result.kind).toBe('error');
    });
  });

  describe('scalar + scalar — replace', () => {
    it('replaces with the new scalar (not an error, not a merge)', () => {
      expect(computeMergeResult('old', 'new')).toEqual({
        kind: 'replace',
        value: 'new',
      });
    });

    it('replaces across scalar types (string → number)', () => {
      expect(computeMergeResult('42', 42)).toEqual({
        kind: 'replace',
        value: 42,
      });
    });

    it('replaces boolean values', () => {
      expect(computeMergeResult(true, false)).toEqual({
        kind: 'replace',
        value: false,
      });
    });
  });

  describe('array existing + non-string array new — pre-#172 characterization', () => {
    // These cases do NOT hit the string[]+string[] union branch (isStringArray
    // fails) nor the scalar-promote branch (value IS an array) nor the
    // error branch (both are arrays). They fall through to the trailing
    // replace. Pinned here so future refactors don't silently alter behavior;
    // changing this is a separate scoped decision beyond #172.
    it('replaces when existing is string[] and new is number[] (no union)', () => {
      expect(computeMergeResult(['a'], [1, 2])).toEqual({
        kind: 'replace',
        value: [1, 2],
      });
    });

    it('replaces when both arrays are mixed type (no union)', () => {
      expect(computeMergeResult([1, 'two'], ['three', 4])).toEqual({
        kind: 'replace',
        value: ['three', 4],
      });
    });
  });
});
