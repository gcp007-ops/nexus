/**
 * The mint itself must resolve-or-reject, not only the envelope.
 *
 * Writing `workspaces/ws_<id>.jsonl` creates that store as a side effect, so an
 * unresolvable identifier mints a phantom workspace instead of failing. These
 * pin each class found in a real vault census (48 of 56 directories phantom or
 * fragmented) to the behavior that makes it uncreatable, and pin the two cases
 * that must keep working: the global store and a workspace being born.
 */

import {
  resolveWorkspaceJsonlPath,
  PhantomWorkspacePathError
} from '../../src/database/repositories/workspacePathGuard';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

const LIVE = [
  { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor' },
  { id: 'd3c9e4f2-5b01-6d8c-1e34-9f0a7b2c4d5e', name: 'Dev' }
];

function makeCache(rows = LIVE): SQLiteCacheManager {
  return {
    async queryOne(sql: string, params: unknown[]) {
      if (sql.includes('COUNT(*)')) {
        return { total: rows.length };
      }
      const value = String(params[0]);
      if (sql.includes('LOWER(name)')) {
        return rows.find(w => w.name.toLowerCase() === value.toLowerCase()) ?? null;
      }
      return rows.find(w => w.id === value) ?? null;
    }
  } as unknown as SQLiteCacheManager;
}

const wsPath = (identifier: string) => `workspaces/ws_${identifier}.jsonl`;

describe('workspace JSONL path guard', () => {
  describe('passes through what must keep working', () => {
    it('leaves non-workspace streams alone', async () => {
      const path = 'conversations/conv_abc-123.jsonl';

      await expect(resolveWorkspaceJsonlPath(path, 'message_added', makeCache()))
        .resolves.toBe(path);
    });

    it('allows the global store, which has no workspaces row', async () => {
      await expect(resolveWorkspaceJsonlPath(wsPath('default'), 'state_saved', makeCache()))
        .resolves.toBe(wsPath('default'));
    });

    it('allows a workspace being created, whose row does not exist yet', async () => {
      // WorkspaceRepository.create writes JSONL first and inserts second, in
      // one transaction. Rejecting here would reject every workspace at birth.
      const born = wsPath('11111111-2222-3333-4444-555555555555');

      await expect(resolveWorkspaceJsonlPath(born, 'workspace_created', makeCache()))
        .resolves.toBe(born);
    });

    it('allows a live workspace id', async () => {
      await expect(resolveWorkspaceJsonlPath(wsPath(LIVE[0].id), 'state_saved', makeCache()))
        .resolves.toBe(wsPath(LIVE[0].id));
    });
  });

  describe('normalizes a name to the canonical id', () => {
    it('rewrites the path so a name and an id do not split one workspace in two', async () => {
      await expect(resolveWorkspaceJsonlPath(wsPath('Desenvolvedor'), 'state_saved', makeCache()))
        .resolves.toBe(wsPath(LIVE[0].id));
    });

    it('matches the name case-insensitively', async () => {
      await expect(resolveWorkspaceJsonlPath(wsPath('desenvolvedor'), 'trace_added', makeCache()))
        .resolves.toBe(wsPath(LIVE[0].id));
    });
  });

  describe('rejects every phantom class from the census', () => {
    const phantoms: Array<[string, string]> = [
      ['parameter name', '--workspaceId'],
      ['parameter name, kebab', '--workspace-id'],
      ['parameter name, short', '--id'],
      ['truncated UUID', 'a8fbad11'],
      ['UUID containing a space', 'c3a4cdbc-54ad-47a d-a43c-691e3071d9d9'],
      ['overlong UUID', 'd3c9e4f2-5b01-6d8c-1e34-9f0a7b2c4d5e5e'],
      ['zeroed UUID', '5078340f-0000-0000-0000-000000000000'],
      ['empty id', ''],
      ['unknown human name', 'Desenvolvimento & Automação']
    ];

    it.each(phantoms)('refuses to mint a store for a %s', async (_label, identifier) => {
      await expect(resolveWorkspaceJsonlPath(wsPath(identifier), 'state_saved', makeCache()))
        .rejects.toBeInstanceOf(PhantomWorkspacePathError);
    });

    it('names the offending identifier in the error', async () => {
      await expect(resolveWorkspaceJsonlPath(wsPath('--workspaceId'), 'trace_added', makeCache()))
        .rejects.toThrow('--workspaceId');
    });

    it('does not let the minting exemption launder an unresolvable id on other events', async () => {
      // The exemption is scoped to workspace_created alone; anything else
      // reaching an unknown id is the phantom path this closes.
      await expect(resolveWorkspaceJsonlPath(wsPath('--workspace'), 'workspace_updated', makeCache()))
        .rejects.toBeInstanceOf(PhantomWorkspacePathError);
    });
  });

  describe('fails open when there is no basis to judge', () => {
    it('allows an unknown id while the workspaces table is still empty', async () => {
      // Repositories write during startup, before the table is populated.
      // Rejecting there would reject legitimate writes in the boot window —
      // the same reason the envelope guard fails open.
      const cold = makeCache([]);

      await expect(resolveWorkspaceJsonlPath(wsPath('--workspaceId'), 'state_saved', cold))
        .resolves.toBe(wsPath('--workspaceId'));
    });

    it('rejects that same id once the table is populated', async () => {
      // The pair is the point: identical input, and only the presence of a
      // basis for judgment decides. Without the COUNT, "unknown workspace" and
      // "table not ready" are the same two empty lookups.
      await expect(resolveWorkspaceJsonlPath(wsPath('--workspaceId'), 'state_saved', makeCache()))
        .rejects.toBeInstanceOf(PhantomWorkspacePathError);
    });
  });
});
