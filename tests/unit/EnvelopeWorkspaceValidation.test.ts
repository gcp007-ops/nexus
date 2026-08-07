/**
 * The envelope workspace guard must accept a workspace by NAME off the live
 * list, not only off the boot-time snapshot.
 *
 * Background: #311 revived `validateWorkspaceId`, which had been dead code, and
 * was careful to name the ALTERNATIVES off the live list precisely because
 * `knownWorkspaces` is a boot-time snapshot that is routinely empty. The
 * acceptance path kept the snapshot, though: a name is only checked against
 * `knownWorkspaces`, and the live list is then consulted for the id alone. On a
 * vault whose snapshot was empty at boot, every by-name call is therefore
 * rejected — and the rejection names, as its "Closest match", the very
 * workspace it just refused. These tests pin the acceptance path to the same
 * live list the error message already reads from.
 */

import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { App } from 'obsidian';
import type { IAgent } from '../../src/agents/interfaces/IAgent';

const LIVE_WORKSPACES = [
  { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor', isArchived: false },
  { id: 'd3c9e4f2-5b01-6d8c-1e34-9f0a7b2c4d5e', name: 'Dev', isArchived: false },
  { id: 'b3bae3e3-7269-44e7-8841-cd9b79e746a4', name: 'Reflexao', isArchived: false }
];

/**
 * An app whose plugin resolves a workspaceService returning the live list.
 * `bootSnapshot` is what the service was constructed with — empty models the
 * common case where SQLite was not query-ready at agent registration.
 */
function makeApp(): App {
  const plugin = {
    services: {
      workspaceService: {
        async listWorkspaces() {
          return LIVE_WORKSPACES;
        }
      }
    }
  };

  return {
    plugins: {
      getPlugin: (id: string) => (id === 'nexus' ? plugin : null)
    }
  } as unknown as App;
}

function makeService(bootSnapshot: Array<{ name: string }> = []) {
  return new ToolBatchExecutionService(makeApp(), new Map<string, IAgent>(), bootSnapshot);
}

const CONTEXT = {
  sessionId: 'test session',
  memory: 'Testing the envelope workspace guard.',
  goal: 'Validate a workspaceId that is a real workspace name.'
};

function envelope(workspaceId: string) {
  return {
    context: { ...CONTEXT, workspaceId },
    calls: [{ agent: 'storageManager', tool: 'list', params: {} }]
  };
}

describe('envelope workspace validation', () => {
  it('accepts a live workspace name when the boot snapshot is empty', async () => {
    const service = makeService([]);

    const result = await service.execute(envelope('Desenvolvedor') as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('accepts a live workspace name case-insensitively', async () => {
    const service = makeService([]);

    const result = await service.execute(envelope('desenvolvedor') as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('accepts a live workspace id', async () => {
    const service = makeService([]);

    const result = await service.execute(envelope('d3c9e4f2-5b01-6d8c-1e34-9f0a7b2c4d5e') as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('still rejects an identifier that is no live workspace', async () => {
    const service = makeService([]);

    const result = await service.execute(envelope('--workspaceId') as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid workspace "--workspaceId"');
  });

  it('never rejects an identifier it then offers back as the closest match', async () => {
    const service = makeService([]);

    for (const workspace of LIVE_WORKSPACES) {
      const result = await service.execute(envelope(workspace.name) as never);
      const error = result.error ?? '';

      // The self-contradiction that made this visible in the field:
      // Invalid workspace "Dev". Closest match: "Dev".
      expect(error).not.toContain(`Closest match: "${workspace.name}"`);
    }
  });
});
