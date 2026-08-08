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
 *
 * Not reusing `sync/resolveWorkspaceId`, which resolves the same way, is
 * deliberate: it matches names with `isArchived = 0` and case-sensitively. An
 * archived workspace still owns a legitimate shard, and rejecting its writes
 * would be a regression; and the id branch matches the full table, so the name
 * branch has to as well or the two forms disagree for archived rows.
 */

import { SQLiteCacheManager } from '../storage/SQLiteCacheManager';

/**
 * The workspace-scoped stream shapes.
 *
 * Both carry a workspaceId in the filename, and `JSONLWriter.appendEvent`
 * creates whatever path it is handed — so both mint a phantom store from an
 * identifier that resolves to nothing.
 *
 * `tasks/` is easy to miss: `TaskRepository.jsonlPath` and
 * `ProjectRepository.jsonlPath` both take a workspaceId, not the entity id
 * their names suggest. Guarding only `workspaces/` would have left the same
 * defect open one directory over.
 */
const WORKSPACE_SCOPED_PATHS = [
  /^(workspaces\/ws_)(.*)\.jsonl$/,
  /^(tasks\/tasks_)(.*)\.jsonl$/
];

/**
 * Split a workspace-scoped path into the part that stays and the identifier
 * that has to resolve. Keeping the prefix is what lets a `tasks/` path be
 * rewritten back into `tasks/` rather than into `workspaces/`.
 */
function parseWorkspaceScopedPath(path: string): { prefix: string; identifier: string } | null {
  for (const shape of WORKSPACE_SCOPED_PATHS) {
    const match = shape.exec(path);
    if (match) {
      return { prefix: match[1], identifier: match[2] };
    }
  }
  return null;
}

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
  const scoped = parseWorkspaceScopedPath(path);
  if (!scoped) {
    // Conversation and message streams are keyed by their own entity id.
    return path;
  }

  const { prefix, identifier } = scoped;

  if (identifier === GLOBAL_WORKSPACE_ID) {
    return path;
  }

  if (eventType === MINTING_EVENT_TYPE) {
    return path;
  }

  let populated: { total: number } | null;
  try {
    // Two lookups rather than one `id = ? OR LOWER(name) = LOWER(?)`, on
    // purpose. Folding them would force the returned row's id to rebuild the
    // path on EVERY hit — including when the identifier was already canonical,
    // where nothing needs rewriting. Asking "does this id exist?" and handing
    // back the untouched path trusts only the presence of a row, not its
    // contents; the rewrite then happens on the one branch that needs it.
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
    // `ws_a8fbad11-…` holding shards for the same territory. Normalize to the
    // id rather than reject, keeping the caller working and the store single.
    const byName = await sqliteCache.queryOne<WorkspaceIdRow>(
      'SELECT id FROM workspaces WHERE LOWER(name) = LOWER(?)',
      [identifier]
    );
    if (byName) {
      return `${prefix}${byName.id}.jsonl`;
    }

    populated = await sqliteCache.queryOne<{ total: number }>(
      'SELECT COUNT(*) AS total FROM workspaces',
      []
    );
  } catch {
    // The cache is not queryable at all — SQLiteCacheManager throws when the
    // database has not been opened yet. That is the earliest form of "no basis
    // to judge", and it is the one that actually happens: repositories write
    // during startup. Without this, the guard would fail CLOSED exactly where
    // it promises to fail open, turning a boot-window write into a hard error.
    return path;
  }

  // Fail OPEN when there is no basis to judge.
  //
  // "Unknown workspace" and "workspaces table not populated yet" are the same
  // empty lookup above. Rejecting on both would reject legitimate writes during
  // the boot window — the same reason ToolBatchExecutionService's envelope
  // guard fails open. One COUNT separates the cases: a populated table means
  // the identifier really is unknown.
  if (!populated || populated.total === 0) {
    return path;
  }

  throw new PhantomWorkspacePathError(identifier);
}
