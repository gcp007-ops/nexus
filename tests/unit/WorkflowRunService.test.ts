import type { App, Plugin } from 'obsidian';
import { WorkflowRunService } from '../../src/services/workflows/WorkflowRunService';
import { WorkflowRunReservationService } from '../../src/services/workflows/WorkflowRunReservationService';
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
  authorityScope: 'vault-synced',
  authorityDeviceId: 'device-a',
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

interface HarnessOverrides {
  chatService?: {
    createConversation: jest.Mock;
    sendMessage: jest.Mock;
  };
  conversationService?: { hasRunKey: jest.Mock };
  authorityService?: { assertCanRun: jest.Mock };
  reservationService?: WorkflowRunReservationService;
}

function createHarness(execution?: WorkflowExecutionConfig, overrides: HarnessOverrides = {}) {
  const selectedWorkflow = workflow(execution);
  const chatService = overrides.chatService ?? {
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
  const conversationService = overrides.conversationService ?? {
    hasRunKey: jest.fn(async () => false)
  };
  const authorityService = overrides.authorityService ?? {
    assertCanRun: jest.fn(() => 'device-a')
  };
  const reservationService = overrides.reservationService ?? new WorkflowRunReservationService();
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
    agentRunService: agentRunService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['agentRunService'],
    conversationService: conversationService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['conversationService'],
    authorityService: authorityService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['authorityService'],
    reservationService
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

  return {
    service,
    chatService,
    agentRunService,
    selectedWorkflow,
    conversationService,
    authorityService,
    reservationService
  };
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
    expect(chatService.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        systemPrompt: 'Resolved CLAUDE.md, workspace, and saved prompt instructions.'
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
      runKey: 'scheduled-run',
      deviceId: 'device-a'
    });
  });

  it('keeps the resolved Claude prompt out of persisted chat settings', async () => {
    const { service, chatService, agentRunService } = createHarness(claudeExecution);

    await service.start({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'manual',
      scheduledFor: 456,
      runKey: 'manual-run'
    });

    const persistedOptions = chatService.createConversation.mock.calls[0]?.[2];
    expect(persistedOptions).not.toEqual(expect.objectContaining({
      systemPrompt: expect.any(String)
    }));
    expect(JSON.stringify(persistedOptions)).not.toContain('Resolved CLAUDE.md');
    expect(agentRunService.start).toHaveBeenCalledWith(expect.objectContaining({
      resolvedPrompt: 'Resolved CLAUDE.md, workspace, and saved prompt instructions.'
    }));
  });

  it('rejects a vault-synced run on a non-authority device before persistence', async () => {
    const authorityService = {
      assertCanRun: jest.fn(() => {
        throw new Error('Workflow authority device mismatch');
      })
    };
    const { service, chatService, agentRunService, conversationService } = createHarness(
      claudeExecution,
      { authorityService }
    );

    await expect(service.start({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'manual',
      scheduledFor: 456,
      runKey: 'manual-run'
    })).rejects.toThrow('Workflow authority device mismatch');

    expect(conversationService.hasRunKey).not.toHaveBeenCalled();
    expect(chatService.createConversation).not.toHaveBeenCalled();
    expect(agentRunService.start).not.toHaveBeenCalled();
  });

  it('reserves one runKey across concurrent services in this Nexus instance', async () => {
    const reservationService = new WorkflowRunReservationService();
    let conversationExists = false;
    let releaseCreate!: () => void;
    let markEntered!: () => void;
    const createEntered = new Promise<void>(resolve => { markEntered = resolve; });
    const createReleased = new Promise<void>(resolve => { releaseCreate = resolve; });
    const conversationService = {
      hasRunKey: jest.fn(async () => conversationExists)
    };
    const chatService = {
      createConversation: jest.fn(async () => {
        markEntered();
        await createReleased;
        conversationExists = true;
        return {
          success: true,
          conversationId: 'conversation-1',
          sessionId: 'session-created'
        };
      }),
      sendMessage: jest.fn(async () => ({ success: true }))
    };
    const shared = { reservationService, conversationService, chatService };
    const first = createHarness(claudeExecution, shared);
    const second = createHarness(claudeExecution, shared);
    const request = {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'scheduled' as const,
      scheduledFor: 456,
      runKey: 'slot-1',
      openInChat: false
    };

    const firstStart = first.service.start(request);
    await createEntered;
    await expect(second.service.start(request))
      .rejects.toThrow('Workflow run is already reserved: slot-1');
    releaseCreate();
    await firstStart;

    expect(chatService.createConversation).toHaveBeenCalledTimes(1);
    expect(first.agentRunService.start).toHaveBeenCalledTimes(1);
    expect(second.agentRunService.start).not.toHaveBeenCalled();
  });
});
