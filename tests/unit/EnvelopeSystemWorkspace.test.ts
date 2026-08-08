/**
 * The envelope guard must accept the system guides workspace.
 *
 * `listWorkspaces()` omits it by design — `WorkspaceServiceSystemGuides.test.ts`
 * asserts exactly that — while `getWorkspaceByNameOrId` resolves it by id and
 * by name, short-circuiting ahead of any table lookup. A guard validating only
 * against the list therefore rejects the one workspace the product hides,
 * while every other caller accepts it.
 */

import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { App } from 'obsidian';
import type { IAgent } from '../../src/agents/interfaces/IAgent';

const SYSTEM_ID = '__system_guides__';
const SYSTEM_NAME = 'Assistant guides';

const LISTED = [
  { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor', isArchived: false }
];

/**
 * Mirrors the real split: `listWorkspaces` never returns the system workspace,
 * `getWorkspaceByNameOrId` resolves it by either identifier.
 */
function makeApp(): App {
  const plugin = {
    services: {
      workspaceService: {
        async listWorkspaces() {
          return LISTED;
        },
        async getWorkspaceByNameOrId(identifier: string) {
          if (
            identifier === SYSTEM_ID
            || identifier.toLowerCase() === SYSTEM_NAME.toLowerCase()
          ) {
            return { id: SYSTEM_ID, name: SYSTEM_NAME, isArchived: false };
          }
          return LISTED.find(w => w.id === identifier) ?? null;
        }
      }
    }
  };

  return {
    plugins: { getPlugin: (id: string) => (id === 'nexus' ? plugin : null) }
  } as unknown as App;
}

function makeService() {
  return new ToolBatchExecutionService(makeApp(), new Map<string, IAgent>(), []);
}

function envelope(workspaceId: string) {
  return {
    context: {
      workspaceId,
      sessionId: 'test session',
      memory: 'Testing the envelope guard against the system workspace.',
      goal: 'Reach the guides workspace through useTools.'
    },
    calls: [{ agent: 'storageManager', tool: 'list', params: {} }]
  };
}

describe('envelope guard and the system guides workspace', () => {
  it('accepts the system workspace by id, which no listing reports', async () => {
    const result = await makeService().execute(envelope(SYSTEM_ID) as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('accepts the system workspace by name', async () => {
    const result = await makeService().execute(envelope(SYSTEM_NAME) as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('accepts the system workspace name case-insensitively', async () => {
    const result = await makeService().execute(envelope('assistant guides') as never);

    expect(result.error ?? '').not.toContain('Invalid workspace');
  });

  it('still rejects an identifier no resolver knows', async () => {
    const result = await makeService().execute(envelope('--workspaceId') as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid workspace "--workspaceId"');
  });

  it('does not advertise the hidden workspace in the rejection message', async () => {
    // The accept path may consult the resolver; the suggestions must not. A
    // workspace omitted from listings should stay omitted from error text.
    const result = await makeService().execute(envelope('--workspaceId') as never);

    expect(result.error).not.toContain(SYSTEM_NAME);
    expect(result.error).not.toContain(SYSTEM_ID);
  });
});
