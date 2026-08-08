/**
 * `resolveWorkspaceId` must match names the same way the layers in front of it do.
 *
 * A caller passing a workspace name meets up to three resolvers, and two of them
 * lowercase both sides: the envelope guard in ToolBatchExecutionService, and
 * WorkspaceService.getWorkspaceByNameOrId. This one used `name = ?`, so a name
 * differing only in case passed validation at the envelope and then failed here
 * — surfacing as "Workspace not found" from the taskManager on a call the guard
 * had already accepted.
 */

import { resolveWorkspaceId } from '../../src/database/sync/resolveWorkspaceId';
import type { ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';

const ROWS = [
  { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor', lastAccessed: 2, isArchived: 0 },
  { id: 'd3c9e4f2-5b01-6d8c-1e34-9f0a7b2c4d5e', name: 'Dev', lastAccessed: 1, isArchived: 0 },
  { id: 'ffffffff-0000-0000-0000-000000000000', name: 'Arquivado', lastAccessed: 0, isArchived: 1 }
];

/** Enough of the cache to answer the two queries the resolver makes. */
function makeCache(): ISQLiteCacheManager {
  const matchesName = (sql: string, value: string) => (row: typeof ROWS[number]) =>
    sql.includes('LOWER(name)')
      ? row.name.toLowerCase() === value.toLowerCase()
      : row.name === value;

  return {
    async queryOne(_sql: string, params: unknown[]) {
      return ROWS.find(r => r.id === String(params[0])) ?? null;
    },
    async query(sql: string, params: unknown[]) {
      const value = String(params[0]);
      return ROWS
        .filter(r => r.isArchived === 0)
        .filter(matchesName(sql, value))
        .map(({ id, lastAccessed }) => ({ id, lastAccessed }));
    }
  } as unknown as ISQLiteCacheManager;
}

describe('resolveWorkspaceId — name matching', () => {
  it('resolves an exactly-cased name', async () => {
    const result = await resolveWorkspaceId('Desenvolvedor', makeCache());

    expect(result.id).toBe(ROWS[0].id);
    expect(result.resolvedFromName).toBe(true);
  });

  it('resolves a name in different case, as the layers in front already accept', async () => {
    const result = await resolveWorkspaceId('desenvolvedor', makeCache());

    expect(result.id).toBe(ROWS[0].id);
    expect(result.resolvedFromName).toBe(true);
  });

  it('resolves an upper-cased name', async () => {
    const result = await resolveWorkspaceId('DESENVOLVEDOR', makeCache());

    expect(result.id).toBe(ROWS[0].id);
  });

  it('still prefers an exact id over any name matching', async () => {
    const result = await resolveWorkspaceId(ROWS[1].id, makeCache());

    expect(result.id).toBe(ROWS[1].id);
    expect(result.resolvedFromName).toBe(false);
  });

  it('still resolves nothing for a name no workspace has', async () => {
    const result = await resolveWorkspaceId('Nao Existe', makeCache());

    expect(result.id).toBeNull();
  });

  it('keeps ignoring archived workspaces', async () => {
    // Case-insensitivity must not widen the set: `isArchived = 0` is a separate
    // decision from how the name is compared, and this change does not touch it.
    const result = await resolveWorkspaceId('arquivado', makeCache());

    expect(result.id).toBeNull();
  });
});
