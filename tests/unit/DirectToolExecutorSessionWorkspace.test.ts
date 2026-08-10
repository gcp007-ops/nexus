import type { App } from 'obsidian';
import { DirectToolExecutor } from '../../src/services/chat/DirectToolExecutor';
import { SessionContextManager } from '../../src/services/SessionContextManager';
import { ToolManagerAgent } from '../../src/agents/toolManager/toolManager';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import type { AgentProvider } from '../../src/services/agent/LazyAgentProvider';

function makeSessionManager(): SessionContextManager {
  const manager = new SessionContextManager();
  manager.setSessionService({
    getSession: jest.fn().mockResolvedValue(null),
    getAllSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn(),
    updateSession: jest.fn()
  });
  return manager;
}

function makeStubAgent(): IAgent {
  const tool = {
    slug: 'run',
    name: 'Run',
    description: 'Run a stub operation',
    version: '1.0.0',
    execute: jest.fn().mockResolvedValue({ success: true }),
    getParameterSchema: () => ({ type: 'object', properties: {} }),
    getResultSchema: () => ({ type: 'object', properties: {} })
  } as unknown as ITool;

  return {
    name: 'stubManager',
    description: 'Stub manager',
    version: '1.0.0',
    getTools: () => [tool],
    getTool: (slug: string) => (slug === 'run' ? tool : undefined),
    initialize: jest.fn(),
    executeTool: jest.fn().mockResolvedValue({ success: true }),
    setAgentManager: jest.fn()
  };
}

function makeHarness(manager: SessionContextManager) {
  const stubAgent = makeStubAgent();
  const registry = new Map<string, IAgent>([['stubManager', stubAgent]]);
  const toolManager = new ToolManagerAgent(
    {} as App,
    registry,
    {
      workspaces: [
        { name: 'ws-engineering' },
        { name: 'ws-research' }
      ],
      customAgents: [],
      vaultRoot: []
    }
  );
  const agents = new Map<string, IAgent>([
    ['toolManager', toolManager],
    ['stubManager', stubAgent]
  ]);
  const provider: AgentProvider = {
    getAllAgents: () => agents,
    getAgent: (name: string) => agents.get(name) ?? null,
    getAgentAsync: async (name: string) => agents.get(name) ?? null
  };
  const batchExecute = jest.spyOn(
    toolManager.getToolBatchExecutionService(),
    'execute'
  ).mockResolvedValue({ success: true, data: { ok: true } });

  return {
    executor: new DirectToolExecutor({
      agentProvider: provider,
      sessionContextManager: manager
    }),
    batchExecute
  };
}

const USE_PARAMS = {
  sessionId: 'planning chat',
  memory: 'Continue the existing workspace task.',
  goal: 'Run the next operation.',
  tool: 'stub run'
};

describe('DirectToolExecutor session workspace propagation', () => {
  it('inherits the workspace established by an explicit getTools call', async () => {
    const manager = makeSessionManager();
    const { executor, batchExecute } = makeHarness(manager);

    await executor.executeTool('getTools', {
      ...USE_PARAMS,
      workspaceId: 'ws-engineering'
    });
    await executor.executeTool('useTools', USE_PARAMS);

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-engineering');
  });

  it('rejects an ambiguous omitted handle before starting a batch', async () => {
    const manager = makeSessionManager();
    await manager.validateSessionId('planning chat', undefined, 'ws-engineering');
    await manager.validateSessionId('planning chat', undefined, 'ws-research');
    const { executor, batchExecute } = makeHarness(manager);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(executor.executeTool('useTools', USE_PARAMS)).rejects.toThrow(/ambiguous.*workspace/i);
    } finally {
      consoleError.mockRestore();
    }

    expect(batchExecute).not.toHaveBeenCalled();
  });

  it('preserves an explicit workspace on first use', async () => {
    const manager = makeSessionManager();
    const { executor, batchExecute } = makeHarness(manager);

    await executor.executeTool('useTools', {
      ...USE_PARAMS,
      workspaceId: 'ws-research'
    });

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-research');
  });

  it('keeps default for a previously unknown handle omitted on first use', async () => {
    const manager = makeSessionManager();
    const { executor, batchExecute } = makeHarness(manager);

    await executor.executeTool('useTools', USE_PARAMS);

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('default');
  });

  it('keeps the legacy default merge when non-ambiguous validation fails', async () => {
    const manager = makeSessionManager();
    manager.validateSessionId = jest.fn().mockRejectedValue(new Error('temporary validation failure'));
    const { executor, batchExecute } = makeHarness(manager);

    await executor.executeTool('useTools', USE_PARAMS);

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('default');
  });
});
