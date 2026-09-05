import type { App } from 'obsidian';
import { WorkspaceIntegrationService } from '../../src/ui/chat/services/WorkspaceIntegrationService';
import { getNexusPlugin } from '../../src/utils/pluginLocator';

jest.mock('../../src/utils/pluginLocator', () => ({
  getNexusPlugin: jest.fn()
}));

describe('WorkspaceIntegrationService', () => {
  const mockedGetNexusPlugin = jest.mocked(getNexusPlugin);

  beforeEach(() => {
    mockedGetNexusPlugin.mockReset();
  });

  it('loads internal chat workspace context through the compact projection', async () => {
    const executeTool = jest.fn().mockImplementation(async (_tool, params) => {
      if (params.workspace !== 'workspace-id') {
        throw new Error('loadWorkspace requires the workspace parameter');
      }
      return {
        success: true,
        data: {
          responseVersion: 2,
          detail: 'compact',
          context: { name: 'Desenvolvedor' },
          omitted: ['tasks', 'states', 'sessions']
        }
      };
    });
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({ id: 'workspace-id' })
    };
    const agentManager = {
      getAgent: jest.fn().mockReturnValue({ executeTool })
    };
    const plugin = {
      getService: jest.fn().mockImplementation(async (name: string) => {
        if (name === 'workspaceService') return workspaceService;
        if (name === 'agentManager') return agentManager;
        return null;
      })
    };

    mockedGetNexusPlugin.mockReturnValue(plugin as never);

    const service = new WorkspaceIntegrationService({} as App);
    const result = await service.loadWorkspace('Desenvolvedor');

    expect(executeTool).toHaveBeenCalledWith('loadWorkspace', {
      workspace: 'workspace-id',
      limit: 3,
      detail: 'compact'
    });
    expect(result).toMatchObject({
      id: 'workspace-id',
      responseVersion: 2,
      detail: 'compact',
      omitted: ['tasks', 'states', 'sessions']
    });
  });
});
