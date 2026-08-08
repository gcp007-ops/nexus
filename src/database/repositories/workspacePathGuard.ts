/**
 * Resolve-or-reject for the workspace identifier that becomes a JSONL path.
 *
 * Writing to `workspaces/ws_<id>.jsonl` CREATES that store as a side effect, so
 * an identifier that resolves to no workspace does not fail — it mints a
 * phantom one, silently and permanently. A census of one vault found 48 of 56
 * workspace directories were phantom or fragmented: flag names that reached
 * storage as values (`ws_--workspaceId`), truncated and space-containing UUIDs,
 * zeroed UUIDs, an empty id, and human names sitting beside the UUID store for
 * the same workspace.
 *
 * The envelope guard in ToolBatchExecutionService closes the `useTools` entry
 * point only. This closes the mint itself, so the classes above are
 * uncreatable regardless of which caller reached the repository.
 *
 * Resolution uses the `workspaces` table on the cache every repository already
 * holds, so no repository gains a dependency on WorkspaceService — which owns
 * WorkspaceRepository and would make the graph circular.
 */

import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';

/** `workspaces/ws_<identifier>.jsonl` — the only path shape this guards. */
const WORKSPACE_JSONL_PATH = /^workspaces\/ws_(.*)\.jsonl$/;

/**
 * The one event that legitimately precedes its own workspace row.
 *
 * WorkspaceRepository.create writes the JSONL event first and inserts into
 * SQLite second, inside one transaction. A strict resolve-or-reject would
 * therefore reject every workspace at birth. Exempting this single event type
 * keeps creation working without widening the hole: none of the phantom
 * classes above originate from a `workspace_created`.
 */
const MINTING_EVENT_TYPE = 'workspace_created';

/** The global store, which is not a row in the workspaces table. */
const GLOBAL_WORKSPACE_ID = 'default';

export class PhantomWorkspacePathError extends Error {
  constructor(public readonly identifier: string) {
    super(
      `Refusing to write to workspace "${identifier}": it resolves to no known workspace, `
      + `and writing would create it as a phantom store. Pass a live workspace id or name.`
    );
    this.name = 'PhantomWorkspacePathError';
  }
}

interface WorkspaceIdRow {
  id: string;
}

/**
 * Resolve a workspace JSONL path to the one written under the CANONICAL id.
 *
 * @param path Relative JSONL path a repository is about to write
 * @param eventType Type of the event being written
 * @param sqliteCache Cache holding the `workspaces` table
 * @returns The path to actually write — unchanged for non-workspace streams,
 *          rewritten to the canonical id when the identifier was a name
 * @throws PhantomWorkspacePathError when the identifier resolves to nothing
 */
export async function resolveWorkspaceJsonlPath(
  path: string,
  eventType: string | undefined,
  sqliteCache: SQLiteCacheManager
): Promise<string> {
  const match = WORKSPACE_JSONL_PATH.exec(path);
  if (!match) {
    // Conversation, task and message streams are keyed by their own entity id.
    return path;
  }

  const identifier = match[1];

  if (identifier === GLOBAL_WORKSPACE_ID) {
    return path;
  }

  if (eventType === MINTING_EVENT_TYPE) {
    return path;
  }

  const byId = await sqliteCache.queryOne<WorkspaceIdRow>(
    'SELECT id FROM workspaces WHERE id = ?',
    [identifier]
  );
  if (byId) {
    return path;
  }

  // A name is a legitimate thing for a caller to hold — the envelope accepts
  // one, and getWorkspaceByNameOrId resolves one. What it must not do is
  // become a path: that is how `ws_Desenvolvedor` came to sit beside
  // `ws_a8fbad11-…` holding shards for the same territory. Normalize to the id
  // rather than reject, so the caller keeps working and the store stays single.
  const byName = await sqliteCache.queryOne<WorkspaceIdRow>(
    'SELECT id FROM workspaces WHERE LOWER(name) = LOWER(?)',
    [identifier]
  );
  if (byName) {
    return `workspaces/ws_${byName.id}.jsonl`;
  }

  // Fail OPEN when there is no basis to judge.
  //
  // "Unknown workspace" and "workspaces table not populated yet" are the same
  // two empty lookups above. Rejecting on both would reject legitimate writes
  // during the boot window — the same reason ToolBatchExecutionService's
  // envelope guard fails open — and repositories write earlier in startup than
  // the envelope ever runs. One COUNT separates the cases: a populated table
  // means the identifier really is unknown.
  const populated = await sqliteCache.queryOne<{ total: number }>(
    'SELECT COUNT(*) AS total FROM workspaces',
    []
  );
  if (!populated || populated.total === 0) {
    return path;
  }

  throw new PhantomWorkspacePathError(identifier);
}
