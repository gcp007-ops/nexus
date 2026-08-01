import { ListStatesTool } from '../../src/agents/memoryManager/tools/states/listStates';
import { ListStatesParams } from '../../src/agents/memoryManager/types';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';

describe('ListStatesTool', () => {
  it('returns metadata needed to verify tag filtering and session linkage', async () => {
    const memoryService = {
      getStates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'state-1',
            name: 'Verification checkpoint',
            description: 'Checkpoint description',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            created: 123,
            tags: ['test', 'verification'],
            state: {
              state: {
                metadata: {
                  tags: ['test', 'verification']
                }
              }
            }
          },
          {
            id: 'state-2',
            name: 'Other checkpoint',
            description: 'Other description',
            sessionId: 'session-2',
            workspaceId: 'workspace-1',
            created: 100,
            tags: ['other'],
            state: {
              state: {
                metadata: {
                  tags: ['other']
                }
              }
            }
          }
        ],
        page: 0,
        pageSize: 10,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      })
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Workspace Name'
      })
    };
    const agent = {
      getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
    } as unknown as MemoryManagerAgent;
    const tool = new ListStatesTool(agent);
    const params: ListStatesParams = {
      context: {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        memory: 'Testing list states.',
        goal: 'Verify metadata is visible.'
      },
      tags: ['test']
    };

    const result = await tool.execute(params);

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Workspace Name');
    expect(memoryService.getStates).toHaveBeenCalledWith('workspace-1', undefined, {
      page: 0,
      pageSize: undefined
    });
    expect(result.data).toEqual([
      {
        id: 'state-1',
        name: 'Verification checkpoint',
        description: 'Checkpoint description',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        created: 123,
        tags: ['test', 'verification']
      }
    ]);
  });

  /**
   * `update-state --tags` rewrites the top-level tags but leaves the stored
   * snapshot's nested `state.metadata.tags` alone, so the nested value is a
   * legacy fallback — never an override. An empty top-level array is how a
   * caller clears tags and must not resurrect the stale nested ones.
   */
  describe('current-tag precedence', () => {
    function buildTool(items: Record<string, unknown>[]): ListStatesTool {
      const memoryService = {
        getStates: jest.fn().mockResolvedValue({
          items,
          page: 0,
          pageSize: 10,
          totalItems: items.length,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false
        })
      };
      const workspaceService = {
        getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
          id: 'workspace-1',
          name: 'Workspace Name'
        })
      };
      const agent = {
        getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
        getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
      } as unknown as MemoryManagerAgent;
      return new ListStatesTool(agent);
    }

    const context = {
      workspaceId: 'Workspace Name',
      sessionId: 'session-1',
      memory: 'Testing tag precedence.',
      goal: 'Verify current tags win over the stored snapshot.'
    };

    function stateWith(tags: string[] | undefined, nestedTags: string[]): Record<string, unknown> {
      return {
        id: 'state-1',
        name: 'Checkpoint',
        description: 'Checkpoint description',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        created: 123,
        tags,
        state: { state: { metadata: { tags: nestedTags } } }
      };
    }

    it('lists the current tags, not the stale nested ones', async () => {
      const tool = buildTool([stateWith(['current'], ['stale'])]);

      const result = await tool.execute({ context });

      expect(result.success).toBe(true);
      expect((result.data as Array<{ tags: string[] }>)[0].tags).toEqual(['current']);
    });

    it('lists an empty current array instead of the stale nested tags', async () => {
      const tool = buildTool([stateWith([], ['stale'])]);

      const result = await tool.execute({ context });

      expect((result.data as Array<{ tags: string[] }>)[0].tags).toEqual([]);
    });

    it('falls back to nested tags only when the current value is absent', async () => {
      const tool = buildTool([stateWith(undefined, ['legacy'])]);

      const result = await tool.execute({ context });

      expect((result.data as Array<{ tags: string[] }>)[0].tags).toEqual(['legacy']);
    });

    it('does not match a filter against stale nested tags when the current array is empty', async () => {
      const tool = buildTool([stateWith([], ['stale'])]);

      const result = await tool.execute({ ...{ context }, tags: ['stale'] });

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('matches a filter against the current tags', async () => {
      const tool = buildTool([stateWith(['current'], ['stale'])]);

      const result = await tool.execute({ ...{ context }, tags: ['current'] });

      expect(result.data).toHaveLength(1);
    });

    it('does not match a filter against tags that are only nested when a current value exists', async () => {
      const tool = buildTool([stateWith(['current'], ['stale'])]);

      const result = await tool.execute({ ...{ context }, tags: ['stale'] });

      expect(result.data).toEqual([]);
    });
  });

  it('returns a clear error when the scoped workspace name cannot be resolved', async () => {
    const memoryService = {
      getStates: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null)
    };
    const agent = {
      getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
    } as unknown as MemoryManagerAgent;
    const tool = new ListStatesTool(agent);

    const result = await tool.execute({
      context: {
        workspaceId: 'Missing Workspace',
        sessionId: 'session-1',
        memory: 'Testing list states.',
        goal: 'Verify workspace name resolution.'
      }
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Workspace not found: Missing Workspace/);
    expect(memoryService.getStates).not.toHaveBeenCalled();
  });
});
