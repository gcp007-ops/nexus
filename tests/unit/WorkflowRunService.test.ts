import type { App, Plugin } from 'obsidian';
import { WorkflowRunService } from '../../src/services/workflows/WorkflowRunService';
import { buildWorkflowKickoffMessage } from '../../src/services/workflows/types';
import type {
  WorkflowExecutionConfig,
  WorkspaceWorkflow
} from '../../src/database/types/workspace/WorkspaceTypes';

jest.mock('../../src/ui/chat/utils/ModelSelectionUtility', () => ({
  ModelSelectionUtility: {
    getAvailableModels: jest.fn(async () => [{ providerId: 'provider-1', modelId: 'model-1' }]),
    findDefaultModelOption: jest.fn(async () => ({ providerId: 'provider-1', modelId: 'model-1' }))
  }
}));

const claudeExecution: WorkflowExecutionConfig = {
  backend: 'claude-cli',
  model: 'sonnet',
  mode: 'proposal',
  capabilityProfile: 'vault-readonly',
  outputSchema: 'vault-change-plan/v1',
  maxTurns: 12,
  timeoutMinutes: 10,
  approvalRequired: true
};

function workflow(execution?: WorkflowExecutionConfig): WorkspaceWorkflow {
  return {
    id: 'workflow-1',
    name: 'Vault hygiene',
    when: 'On demand',
    steps: 'Inspect the vault and propose bounded operations.',
    promptId: 'prompt-1',
    execution
  };
}

function createHarness(execution?: WorkflowExecutionConfig) {
  const selectedWorkflow = workflow(execution);
  const chatService = {
    createConversation: jest.fn(async () => ({
      success: true,
      conversationId: 'conversation-1',
      sessionId: 'session-created'
    })),
    sendMessage: jest.fn(async () => ({ success: true }))
  };
  const agentRunService = {
    start: jest.fn(async () => ({ runId: 'conversation-1', status: 'running' }))
  };
  const workspaceService = {
    getWorkspace: jest.fn(async () => ({
      id: 'workspace-1',
      name: 'Development',
      context: { workflows: [selectedWorkflow] }
    }))
  };
  const customPromptStorage = {
    getPromptByNameOrId: jest.fn(() => ({
      id: 'prompt-1',
      name: 'Guardian',
      description: 'Guard the vault.',
      prompt: 'Use the saved guardian instructions.',
      isEnabled: true
    }))
  };
  const app = { workspace: {} } as unknown as App;
  const plugin = {} as Plugin;
  const service = new WorkflowRunService({
    app,
    plugin,
    chatService: chatService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['chatService'],
    workspaceService: workspaceService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['workspaceService'],
    customPromptStorage: customPromptStorage as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['customPromptStorage'],
    agentRunService: agentRunService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['agentRunService']
  });
  const internals = service as unknown as {
    workspaceIntegration: {
      loadWorkspace: (workspaceId: string) => Promise<Record<string, unknown> | null>;
    };
    systemPromptBuilder: {
      build: (params: unknown) => Promise<string>;
    };
  };
  internals.workspaceIntegration = {
    loadWorkspace: jest.fn(async () => ({ workflowDefinitions: [selectedWorkflow] }))
  };
  internals.systemPromptBuilder = {
    build: jest.fn(async () => 'Resolved CLAUDE.md, workspace, and saved prompt instructions.')
  };

  return { service, chatService, agentRunService, selectedWorkflow };
}

describe('WorkflowRunService', () => {
  it.each([
    ['an absent execution block', undefined],
    ['the chat backend', { ...claudeExecution, backend: 'chat' as const }]
  ])('preserves the legacy chat flow for %s', async (_label, execution) => {
    const { service, chatService, agentRunService, selectedWorkflow } = createHarness(execution);
    const scheduledFor = 123;

    const result = await service.start({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'manual',
      scheduledFor,
      runKey: 'legacy-run',
      openInChat: false
    });

    expect(result).toEqual({
      conversationId: 'conversation-1',
      sessionId: 'session-created'
    });
    expect(chatService.sendMessage).toHaveBeenCalledWith(
      'conversation-1',
      buildWorkflowKickoffMessage(selectedWorkflow, 'manual', scheduledFor),
      expect.objectContaining({
        provider: 'provider-1',
        model: 'model-1',
        workspaceId: 'workspace-1'
      })
    );
    expect(agentRunService.start).not.toHaveBeenCalled();
  });

  it('creates and queues a Claude proposal without sending it through chat', async () => {
    const { service, chatService, agentRunService, selectedWorkflow } = createHarness(claudeExecution);

    const result = await service.start({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'scheduled',
      scheduledFor: 456,
      runKey: 'scheduled-run',
      openInChat: false
    });

    expect(result).toEqual({
      conversationId: 'conversation-1',
      sessionId: 'session-created',
      runId: 'conversation-1'
    });
    expect(chatService.createConversation).toHaveBeenCalledWith(
      expect.stringContaining('Vault hygiene'),
      undefined,
      expect.objectContaining({
        workspaceId: 'workspace-1',
        workflowId: 'workflow-1',
        runTrigger: 'scheduled',
        runKey: 'scheduled-run'
      })
    );
    expect(chatService.sendMessage).not.toHaveBeenCalled();
    expect(agentRunService.start).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
      workflow: selectedWorkflow,
      execution: claudeExecution,
      resolvedPrompt: 'Resolved CLAUDE.md, workspace, and saved prompt instructions.',
      runTrigger: 'scheduled',
      scheduledFor: 456,
      runKey: 'scheduled-run'
    });
  });
});
