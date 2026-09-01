import { LoadWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/loadWorkspace';
import type { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import type { ProjectWorkspace } from '../../src/database/types/workspace/WorkspaceTypes';

const emptyPage = {
  items: [],
  page: 0,
  pageSize: 1,
  totalItems: 0,
  totalPages: 0,
  hasNextPage: false,
  hasPreviousPage: false
};

function createTool() {
  const workspace: ProjectWorkspace = {
    id: 'ws-dev',
    name: 'Desenvolvedor',
    rootFolder: '_Base',
    created: 1,
    lastAccessed: 2,
    context: {
      purpose: 'Governar a vault',
      keyFiles: ['CLAUDE.md', '_Base/Workflows/Desenvolvedor/WF-Roteador.md'],
      workflows: []
    }
  };
  const workspaceService = {
    isSystemWorkspaceId: jest.fn().mockReturnValue(false),
    getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
    updateLastAccessed: jest.fn().mockResolvedValue(undefined)
  };
  const memoryService = {
    getMemoryTraces: jest.fn().mockResolvedValue(emptyPage),
    getSessions: jest.fn().mockResolvedValue(emptyPage),
    getStates: jest.fn().mockResolvedValue(emptyPage)
  };
  const taskSummary = {
    projects: { total: 1, active: 1, items: [] },
    tasks: {
      total: 1,
      byStatus: { todo: 1, in_progress: 0, done: 0, cancelled: 0 },
      overdue: 0,
      nextActions: [],
      recentlyCompleted: []
    }
  };
  const taskService = {
    getWorkspaceSummary: jest.fn().mockResolvedValue(taskSummary)
  };
  const cacheManager = {
    getRecentFiles: jest.fn().mockReturnValue([])
  };
  const app = {
    vault: {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      getFiles: jest.fn().mockReturnValue([])
    }
  };

  const tool = new LoadWorkspaceTool({
    getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
    getMemoryService: jest.fn().mockReturnValue(memoryService),
    getTaskService: jest.fn().mockReturnValue(taskService),
    getCacheManager: jest.fn().mockReturnValue(cacheManager),
    getApp: jest.fn().mockReturnValue(app),
    plugin: {},
    customPromptStorage: undefined
  } as unknown as MemoryManagerAgent);

  return {
    cacheManager,
    memoryService,
    taskService,
    taskSummary,
    tool,
    workspaceService
  };
}

describe('LoadWorkspaceTool compact detail', () => {
  it('publishes compact and full as the only supported detail values', () => {
    const { tool } = createTool();
    const schema = tool.getParameterSchema() as {
      properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown }>;
    };

    expect(schema.properties?.detail).toMatchObject({
      type: 'string',
      enum: ['compact', 'full'],
      default: 'full'
    });
  });

  it('documents the compact response envelope and navigation fields', () => {
    const { tool } = createTool();
    const schema = tool.getResultSchema() as {
      properties?: Record<string, {
        enum?: unknown[];
        properties?: Record<string, {
          properties?: Record<string, unknown>;
        }>;
      }>;
    };

    expect(schema.properties?.responseVersion).toBeDefined();
    expect(schema.properties?.detail).toMatchObject({ enum: ['compact', 'full'] });
    expect(schema.properties?.data?.properties?.navigation).toBeDefined();
    expect(schema.properties?.data?.properties?.omitted).toBeDefined();
  });

  it('returns compact navigation before querying tasks, memory, or files', async () => {
    const {
      cacheManager,
      memoryService,
      taskService,
      tool,
      workspaceService
    } = createTool();

    const result = await tool.execute({
      workspace: 'Desenvolvedor',
      detail: 'compact',
      limit: 1
    });

    expect(result).toMatchObject({
      success: true,
      responseVersion: 2,
      detail: 'compact',
      workspaceContext: { workspaceId: 'ws-dev' }
    });
    expect(result.data).toHaveProperty('navigation');
    expect(result.data).not.toHaveProperty('taskSummary');
    expect(result.data).not.toHaveProperty('sessions');
    expect(result.data).not.toHaveProperty('states');
    expect(taskService.getWorkspaceSummary).not.toHaveBeenCalled();
    expect(memoryService.getMemoryTraces).not.toHaveBeenCalled();
    expect(memoryService.getSessions).not.toHaveBeenCalled();
    expect(memoryService.getStates).not.toHaveBeenCalled();
    expect(cacheManager.getRecentFiles).not.toHaveBeenCalled();
    expect(workspaceService.updateLastAccessed).toHaveBeenCalledWith('ws-dev');
  });

  it('keeps the legacy full load as the default during migration', async () => {
    const { taskService, taskSummary, tool } = createTool();

    const result = await tool.execute({ workspace: 'Desenvolvedor', limit: 1 });

    expect(result).toMatchObject({
      success: true,
      responseVersion: 1,
      detail: 'full'
    });
    expect(result.data).toHaveProperty('taskSummary', taskSummary);
    expect(taskService.getWorkspaceSummary).toHaveBeenCalledWith('ws-dev');
  });
});
