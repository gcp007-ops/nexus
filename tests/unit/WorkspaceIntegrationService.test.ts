import type { App } from 'obsidian';
import { WorkspaceIntegrationService } from '../../src/ui/chat/services/WorkspaceIntegrationService';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
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
    const readWorkspaceBriefing = jest.fn().mockResolvedValue({
      success: true,
      data: {
        responseVersion: 2,
        detail: 'compact',
        context: { name: 'Desenvolvedor' },
        omitted: ['tasks', 'states', 'sessions']
      },
      workspaceContext: { workspaceId: 'workspace-id' }
    });
    const memory = Object.assign(Object.create(MemoryManagerAgent.prototype), { readWorkspaceBriefing });
    const agentManager = { getAgent: jest.fn().mockReturnValue(memory) };
    const plugin = {
      getService: jest.fn().mockImplementation(async (name: string) => (name === 'agentManager' ? agentManager : null))
    };

    mockedGetNexusPlugin.mockReturnValue(plugin as never);

    const service = new WorkspaceIntegrationService({} as App);
    const result = await service.loadWorkspace('Desenvolvedor');

    expect(readWorkspaceBriefing).toHaveBeenCalledWith(expect.objectContaining({
      workspace: 'Desenvolvedor',
      limit: 3,
      detail: 'compact'
    }));
    expect(result).toMatchObject({
      id: 'workspace-id',
      responseVersion: 2,
      detail: 'compact',
      omitted: ['tasks', 'states', 'sessions']
    });
  });
});
