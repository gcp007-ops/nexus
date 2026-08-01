/**
 * Location: src/database/repositories/metadataUpdate.ts
 *
 * Metadata Update Resolver
 *
 * Pure operation shared by TaskRepository and ProjectRepository that turns a
 * caller's metadata request into the complete final metadata object to persist.
 *
 * Why this exists: `task update --metadata` and `task update-project --metadata`
 * document a key merge, but both repositories used to serialize the incoming
 * partial object as the whole value, silently dropping unrelated keys. The merge
 * has to happen against the value read inside the repository transaction — a
 * service-level or cache-level read can be stale by the time the write lands.
 *
 * Contract:
 * - default mode is `merge`: a shallow key merge, so unrelated keys survive and
 *   nested objects are replaced rather than merged recursively;
 * - `metadataMode: "replace"` restores whole-object replacement and requires an
 *   explicit `metadata` object; `{}` clears all metadata;
 * - `removeMetadataKeys` deletes keys in merge mode, applied after the patch;
 * - an empty patch with no effective removals is a no-op and returns undefined,
 *   so the caller can omit metadata from both stores.
 *
 * Validation lives here rather than in the tool schemas because Nexus tool
 * schemas are documentation for the model, not runtime validators.
 *
 * Related Files:
 * - src/database/repositories/TaskRepository.ts - caller (task update)
 * - src/database/repositories/ProjectRepository.ts - caller (project update)
 */

export type MetadataUpdateMode = 'merge' | 'replace';

export interface MetadataUpdateOperation {
  /** Metadata currently persisted, read inside the caller's transaction. */
  current?: Record<string, unknown>;
  /** Incoming patch (merge mode) or complete replacement (replace mode). */
  metadata?: Record<string, unknown>;
  /** Defaults to 'merge'. */
  metadataMode?: MetadataUpdateMode;
  /** Keys to delete after applying the patch. Merge mode only. */
  removeMetadataKeys?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shallow copy that drops explicitly-undefined values.
 *
 * An incoming `undefined` means "no change" everywhere else in the repository
 * layer, and JSON serialization would drop such a key anyway — turning it into a
 * silent, undocumented deletion. `removeMetadataKeys` is the only removal path.
 */
function copyDefinedEntries(source: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      copy[key] = value;
    }
  }
  return copy;
}

function validateRemovalKeys(removeMetadataKeys: unknown): string[] {
  if (removeMetadataKeys === undefined) {
    return [];
  }
  if (!Array.isArray(removeMetadataKeys)) {
    throw new Error('removeMetadataKeys must be an array of non-empty strings');
  }
  const keys: string[] = [];
  for (const key of removeMetadataKeys as unknown[]) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('removeMetadataKeys must be an array of non-empty strings');
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Resolve the complete metadata object to persist.
 *
 * @returns the full final object, or undefined when the request changes nothing
 *          and metadata should be omitted from the event and the SQLite column.
 * @throws when the request is internally inconsistent (bad mode, replacement
 *         without an object, replacement combined with removals, malformed
 *         patch or removal keys).
 */
export function resolveMetadataUpdate(
  operation: MetadataUpdateOperation
): Record<string, unknown> | undefined {
  const { current, metadata, metadataMode, removeMetadataKeys } = operation;

  if (metadataMode !== undefined && metadataMode !== 'merge' && metadataMode !== 'replace') {
    throw new Error('metadataMode must be either "merge" or "replace"');
  }
  if (metadata !== undefined && !isPlainObject(metadata)) {
    throw new Error('metadata must be an object');
  }

  const removals = validateRemovalKeys(removeMetadataKeys);
  const mode: MetadataUpdateMode = metadataMode ?? 'merge';

  if (mode === 'replace') {
    if (metadata === undefined) {
      throw new Error('metadataMode "replace" requires an explicit metadata object');
    }
    if (removals.length > 0) {
      throw new Error(
        'removeMetadataKeys cannot be combined with metadataMode "replace" — replacement already discards every key not present in metadata'
      );
    }
    return copyDefinedEntries(metadata);
  }

  const patch = metadata === undefined ? {} : copyDefinedEntries(metadata);
  const patchKeys = Object.keys(patch);
  const base = isPlainObject(current) ? current : {};
  const effectiveRemovals = removals.filter(
    key => Object.prototype.hasOwnProperty.call(base, key) || Object.prototype.hasOwnProperty.call(patch, key)
  );

  if (patchKeys.length === 0 && effectiveRemovals.length === 0) {
    return undefined;
  }

  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const key of effectiveRemovals) {
    delete merged[key];
  }

  return merged;
}
