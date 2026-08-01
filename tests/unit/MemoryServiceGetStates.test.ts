import { MemoryService } from '../../src/agents/memoryManager/services/MemoryService';
import type { Plugin } from 'obsidian';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';

/**
 * Defensive guard: MemoryService.getStates must surface `isArchived` for
 * tagged states by reading full JSONL content via adapter.getState — NOT
 * by short-circuiting on the SQLite metadata fast-path when `stateMeta.tags`
 * is cached.
 *
 * Pre-fix (PR #216 read-path follow-up), MemoryService.ts:555 had:
 *   const fullState = stateMeta.tags ? null : await adapter.getState(stateMeta.id);
 *
 * For tagged states, this skipped the content fetch — `state.metadata.isArchived`
 * never surfaced, so both the workspace-settings states UI filter and the
 * LLM-facing listStates filter (listStates.ts:106) treated archived tagged
 * states as visible. The archive icon would write state_updated correctly but
 * the next read returned a skeleton without isArchived.
 *
 * Proper long-term fix is to denormalize isArchived into SQLite metadata
 * (v13 migration) so the fast-path can return a complete view without the
 * JSONL round-trip. Tracked as a separate follow-up.
 */
describe('MemoryService.getStates (isArchived surfacing for tagged states)', () => {
  const taggedArchivedStateMeta = {
    id: 'state-tagged-archived',
    name: 'Tagged Archived State',
    description: 'A state with tags that has been archived',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    created: 1717000000000,
    tags: ['draft', 'review']
  };

  const taggedArchivedContent = {
    id: 'state-tagged-archived',
    name: 'Tagged Archived State',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    created: 1717000000000,
    state: {
      workspace: null,
      recentTraces: [],
      contextFiles: [],
      metadata: {
        tags: ['draft', 'review'],
        isArchived: true
      }
    }
  };

  function buildService(adapterOverrides: Partial<IStorageAdapter>): MemoryService {
    const adapter = {
      isReady: () => true,
      getStates: jest.fn().mockResolvedValue({
        items: [taggedArchivedStateMeta],
        total: 1,
        page: 0,
        pageSize: 50,
        hasMore: false
      }),
      getState: jest.fn().mockResolvedValue({ content: taggedArchivedContent }),
      ...adapterOverrides
    } as unknown as IStorageAdapter;

    const workspaceService = {
      getWorkspace: jest.fn()
    } as unknown as WorkspaceService;

    const plugin = {} as unknown as Plugin;
    return new MemoryService(plugin, workspaceService, adapter);
  }

  it('surfaces state.metadata.isArchived for tagged states by reading full content', async () => {
    const getStateMock = jest.fn().mockResolvedValue({ content: taggedArchivedContent });
    const service = buildService({ getState: getStateMock });

    const result = await service.getStates('workspace-1');

    expect(getStateMock).toHaveBeenCalledWith('state-tagged-archived');

    const returned = result.items.find((s) => s.id === 'state-tagged-archived');
    expect(returned).toBeDefined();
    const metadata = returned?.state?.state?.metadata as { isArchived?: boolean; tags?: unknown } | undefined;
    expect(metadata?.isArchived).toBe(true);
  });

  it('preserves the cached tags from SQLite metadata when content is fetched', async () => {
    const service = buildService({});

    const result = await service.getStates('workspace-1');
    const returned = result.items.find((s) => s.id === 'state-tagged-archived');

    expect(returned?.tags).toEqual(['draft', 'review']);
  });

  it('calls adapter.getState for tagged states (no shortcut)', async () => {
    const getStateMock = jest.fn().mockResolvedValue({ content: taggedArchivedContent });
    const service = buildService({ getState: getStateMock });

    await service.getStates('workspace-1');

    expect(getStateMock).toHaveBeenCalledTimes(1);
    expect(getStateMock).toHaveBeenCalledWith('state-tagged-archived');
  });

  /**
   * getStates normalizes tags for every downstream reader (listStates, the
   * workspace summary fetcher). The current top-level value is authoritative;
   * the stored snapshot's nested tags are a legacy fallback. An empty current
   * array — how a caller clears tags — must not resurrect the nested ones here,
   * or the contamination reaches consumers before they can apply any rule.
   */
  describe('current-tag precedence', () => {
    function contentWithNestedTags(nestedTags: string[]) {
      return {
        id: 'state-1',
        name: 'Checkpoint',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        created: 1717000000000,
        state: {
          workspace: null,
          recentTraces: [],
          contextFiles: [],
          metadata: { tags: nestedTags, isArchived: false }
        }
      };
    }

    function serviceWith(tags: string[] | undefined, nestedTags: string[]): MemoryService {
      const adapter = {
        isReady: () => true,
        getStates: jest.fn().mockResolvedValue({
          items: [{
            id: 'state-1',
            name: 'Checkpoint',
            description: 'Checkpoint description',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            created: 1717000000000,
            tags
          }],
          total: 1,
          page: 0,
          pageSize: 50,
          hasMore: false
        }),
        getState: jest.fn().mockResolvedValue({ content: contentWithNestedTags(nestedTags) })
      } as unknown as IStorageAdapter;

      const workspaceService = { getWorkspace: jest.fn() } as unknown as WorkspaceService;
      return new MemoryService({} as unknown as Plugin, workspaceService, adapter);
    }

    it('prefers the current tags over the stale nested ones', async () => {
      const result = await serviceWith(['current'], ['stale']).getStates('workspace-1');

      expect(result.items[0].tags).toEqual(['current']);
      expect(result.items[0].state?.state?.metadata?.tags).toEqual(['current']);
    });

    it('treats an empty current array as authoritative', async () => {
      const result = await serviceWith([], ['stale']).getStates('workspace-1');

      expect(result.items[0].tags).toEqual([]);
      expect(result.items[0].state?.state?.metadata?.tags).toEqual([]);
    });

    it('falls back to nested tags only when the current value is absent', async () => {
      const result = await serviceWith(undefined, ['legacy']).getStates('workspace-1');

      expect(result.items[0].tags).toEqual(['legacy']);
    });

    it('keeps unrelated snapshot metadata while normalizing tags', async () => {
      const result = await serviceWith([], ['stale']).getStates('workspace-1');

      const metadata = result.items[0].state?.state?.metadata as { isArchived?: boolean };
      expect(metadata?.isArchived).toBe(false);
    });
  });
});
