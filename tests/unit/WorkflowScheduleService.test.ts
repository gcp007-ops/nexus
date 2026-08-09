import type { App, Plugin } from 'obsidian';
import type { ConversationData } from '../../src/types/chat/ChatTypes';
import { BackgroundProcessor } from '../../src/core/background/BackgroundProcessor';
import {
  AgentRunService,
  type AgentRunConversationStore
} from '../../src/services/workflows/AgentRunService';
import type {
  WorkflowExecutionHandle,
  WorkflowExecutionRequest,
  WorkflowExecutionResult
} from '../../src/services/workflows/WorkflowExecutionBackend';
import { WorkflowAuthorityService } from '../../src/services/workflows/WorkflowAuthorityService';
import { WorkflowRunService } from '../../src/services/workflows/WorkflowRunService';
import { WorkflowScheduleService } from '../../src/services/workflows/WorkflowScheduleService';
import { WorkflowRunConflictError } from '../../src/services/workflows/WorkflowRunReservationService';
import { WorkflowRunReservationService } from '../../src/services/workflows/WorkflowRunReservationService';
import type { WorkspaceWorkflow } from '../../src/database/types/workspace/WorkspaceTypes';
import type { WorkflowRunRequest } from '../../src/services/workflows/types';

const NOW = new Date(2026, 7, 9, 2, 0, 0, 0).getTime();
const LAST_CHECK = new Date(2026, 7, 8, 0, 0, 0, 0).getTime();
const DUE_SLOT = new Date(2026, 7, 8, 1, 0, 0, 0).getTime();

function createHarness(startImplementation: (request: WorkflowRunRequest) => Promise<unknown>) {
  const plugin = {
    registerInterval: jest.fn()
  } as unknown as Plugin;
  const settings = {
    settings: {
      workflowScheduler: { lastCheckAt: LAST_CHECK }
    },
    saveSettings: jest.fn(async () => undefined)
  };
  const workflowRunService = {
    start: jest.fn(startImplementation),
    approveAndApply: jest.fn()
  };
  const workspaceService = {
    getAllWorkspaces: jest.fn(async () => [{
      id: 'workspace-1',
      isActive: true,
      context: {
        workflows: [{
          id: 'workflow-1',
          name: 'Scheduled guardian',
          when: 'Daily',
          steps: 'Inspect and propose.',
          execution: {
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
          },
          schedule: {
            enabled: true,
            frequency: 'daily',
            hour: 1,
            minute: 0,
            catchUp: 'all'
          }
        }]
      }
    }])
  };
  const conversationService = {
    hasRunKey: jest.fn(async () => false)
  };
  const authorityService = {
    assertCanRun: jest.fn(() => 'device-a')
  };
  const service = new WorkflowScheduleService({
    plugin,
    settings: settings as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['settings'],
    workspaceService: workspaceService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['workspaceService'],
    workflowRunService: workflowRunService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['workflowRunService'],
    authorityService
  } as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]);

  return {
    service,
    plugin,
    settings,
    workflowRunService,
    workspaceService,
    conversationService,
    authorityService
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await Promise.resolve();
  }
}

describe('WorkflowScheduleService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers scheduling and returns without awaiting an unresolved due run', async () => {
    const never = new Promise<never>(() => undefined);
    const { service, plugin, workflowRunService } = createHarness(() => never);
    let settled = false;

    void service.start().then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(plugin.registerInterval).toHaveBeenCalledTimes(1);
    expect(workflowRunService.start).toHaveBeenCalledTimes(1);
  });

  it('dispatches only a proposal job and never invokes an approval path', async () => {
    const { service, workflowRunService } = createHarness(async () => ({
      conversationId: 'conversation-1',
      runId: 'conversation-1'
    }));

    await service.dispatchDueRun({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'scheduled',
      scheduledFor: DUE_SLOT,
      runKey: `workspace-1:workflow-1:${DUE_SLOT}`,
      openInChat: false
    });

    expect(workflowRunService.start).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runTrigger: 'scheduled',
      scheduledFor: DUE_SLOT,
      runKey: `workspace-1:workflow-1:${DUE_SLOT}`,
      openInChat: false
    });
    expect(workflowRunService.approveAndApply).not.toHaveBeenCalled();
  });

  it('delegates runKey reservation to WorkflowRunService without a scheduler precheck', async () => {
    const { service, workflowRunService, conversationService } = createHarness(async () => ({
      conversationId: 'conversation-1'
    }));

    await service.scanDueWorkflows(false);

    expect(conversationService.hasRunKey).not.toHaveBeenCalled();
    expect(workflowRunService.start).toHaveBeenCalledTimes(2);
  });

  it('does not calculate or dispatch a synchronized schedule on a non-authority device', async () => {
    const { service, workflowRunService, authorityService } = createHarness(async () => ({
      conversationId: 'conversation-1'
    }));
    authorityService.assertCanRun.mockImplementation(() => {
      throw new Error('Workflow authority device mismatch');
    });

    await service.scanDueWorkflows(false);

    expect(authorityService.assertCanRun).toHaveBeenCalledTimes(1);
    expect(workflowRunService.start).not.toHaveBeenCalled();
  });

  it('dispatches a synchronized schedule on its configured authority device', async () => {
    const { service, workflowRunService, authorityService } = createHarness(async () => ({
      conversationId: 'conversation-1'
    }));

    await service.scanDueWorkflows(false);

    expect(authorityService.assertCanRun).toHaveBeenCalledTimes(1);
    expect(workflowRunService.start).toHaveBeenCalledTimes(2);
  });

  it('skips a reserved slot and continues scanning later due slots', async () => {
    let attempt = 0;
    const { service, workflowRunService } = createHarness(async request => {
      attempt += 1;
      if (attempt === 1) {
        throw new WorkflowRunConflictError('reserved', request.runKey ?? 'missing');
      }
      return { conversationId: 'conversation-2' };
    });

    await expect(service.scanDueWorkflows(false)).resolves.toBeUndefined();

    expect(workflowRunService.start).toHaveBeenCalledTimes(2);
  });
});

describe('BackgroundProcessor workflow startup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reconciles interrupted runs before starting the detached scheduler', async () => {
    const calls: string[] = [];
    const agentRunService = {
      reconcileInterrupted: jest.fn(async () => {
        calls.push('reconcile');
      })
    };
    const workflowScheduleService = {
      start: jest.fn(async () => {
        calls.push('schedule');
      })
    };
    const getService = jest.fn(async (name: string) => {
      if (name === 'agentRunService') {
        return agentRunService;
      }
      if (name === 'workflowScheduleService') {
        return workflowScheduleService;
      }
      return null;
    });
    const processor = new BackgroundProcessor({
      plugin: {} as Plugin,
      settings: {} as never,
      serviceManager: {} as never,
      getService: getService as never,
      waitForService: jest.fn() as never,
      isInitialized: () => true
    });

    processor.startBackgroundStartupProcessing();
    jest.advanceTimersByTime(2_000);
    await flushMicrotasks();

    expect(agentRunService.reconcileInterrupted).toHaveBeenCalledTimes(1);
    expect(workflowScheduleService.start).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['reconcile', 'schedule']);
  });

  it('finishes startup and queues one run after service readiness when the backend never settles', async () => {
    const never = new Promise<WorkflowExecutionResult>(() => undefined);
    const backendStartReadiness: boolean[] = [];
    let servicesReady = false;
    const claudeCliWorkflowBackend = {
      start: jest.fn((request: WorkflowExecutionRequest): WorkflowExecutionHandle => {
        backendStartReadiness.push(servicesReady);
        return {
          runId: request.runId,
          result: never,
          cancel: jest.fn(async () => undefined)
        };
      })
    };
    const conversations = new Map<string, ConversationData>();
    const conversationStore: AgentRunConversationStore = {
      getConversation: jest.fn(async (id: string) => conversations.get(id) ?? null),
      addMessage: jest.fn(async () => undefined),
      mutateConversationMetadata: jest.fn(async (conversationId, mutate) => {
        const conversation = conversations.get(conversationId);
        if (!conversation) {
          throw new Error(`Conversation not found: ${conversationId}`);
        }
        const metadata = mutate(conversation.metadata ?? {});
        if (metadata === null) {
          return { applied: false };
        }
        conversation.metadata = metadata;
        return { applied: true, metadata };
      }),
      listConversationsWithMetadata: jest.fn(async () => Array.from(conversations.values()))
    };
    const agentRunService = new AgentRunService({
      conversations: conversationStore,
      backend: claudeCliWorkflowBackend,
      applier: {
        apply: jest.fn(),
        reconcile: jest.fn()
      } as never,
      hashSnapshot: jest.fn(async (snapshot: string) => (
        snapshot.includes('Resolved startup instructions')
          ? `sha256:${'a'.repeat(64)}`
          : `sha256:${'b'.repeat(64)}`
      )),
      now: () => NOW
    });
    const execution = {
      backend: 'claude-cli' as const,
      authorityScope: 'vault-synced' as const,
      authorityDeviceId: 'device-a',
      model: 'sonnet',
      mode: 'proposal' as const,
      capabilityProfile: 'vault-readonly' as const,
      outputSchema: 'vault-change-plan/v1' as const,
      maxTurns: 12,
      timeoutMinutes: 10,
      approvalRequired: true as const
    };
    const scheduledWorkflow: WorkspaceWorkflow = {
      id: 'workflow-1',
      name: 'Scheduled guardian',
      when: 'Daily',
      steps: 'Inspect and propose.',
      execution,
      schedule: {
        enabled: true,
        frequency: 'daily',
        hour: 1,
        minute: 0,
        catchUp: 'all'
      }
    };
    const workspace = {
      id: 'workspace-1',
      name: 'Development',
      isActive: true,
      context: { workflows: [scheduledWorkflow] }
    };
    const workspaceService = {
      getWorkspace: jest.fn(async () => workspace),
      getAllWorkspaces: jest.fn(async () => [workspace])
    };
    const authorityService = new WorkflowAuthorityService({
      loadLocalStorage: jest.fn(() => 'device-a')
    } as unknown as App);
    const chatService = {
      createConversation: jest.fn(async (
        title: string,
        _id: string | undefined,
        chatSettings: Record<string, unknown>
      ) => {
        const conversationId = `conversation-${conversations.size + 1}`;
        conversations.set(conversationId, {
          id: conversationId,
          title,
          messages: [],
          created: NOW,
          updated: NOW,
          metadata: { chatSettings: chatSettings as never }
        });
        return { success: true, conversationId, sessionId: 'session-1' };
      }),
      sendMessage: jest.fn()
    };
    const conversationService = {
      hasRunKey: jest.fn(async (runKey: string) => Array.from(conversations.values()).some(
        conversation => conversation.metadata?.chatSettings?.runKey === runKey
      ))
    };
    const app = { workspace: {} } as unknown as App;
    const workflowRunService = new WorkflowRunService({
      app,
      plugin: {} as Plugin,
      chatService: chatService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['chatService'],
      workspaceService: workspaceService as unknown as ConstructorParameters<typeof WorkflowRunService>[0]['workspaceService'],
      customPromptStorage: null,
      agentRunService,
      conversationService,
      authorityService,
      reservationService: new WorkflowRunReservationService()
    });
    const workflowRunInternals = workflowRunService as unknown as {
      workspaceIntegration: {
        loadWorkspace: (workspaceId: string) => Promise<Record<string, unknown> | null>;
      };
      systemPromptBuilder: {
        build: (params: unknown) => Promise<string>;
      };
    };
    workflowRunInternals.workspaceIntegration = {
      loadWorkspace: jest.fn(async () => ({ workflowDefinitions: [scheduledWorkflow] }))
    };
    workflowRunInternals.systemPromptBuilder = {
      build: jest.fn(async () => 'Resolved startup instructions')
    };
    const plugin = { registerInterval: jest.fn() } as unknown as Plugin;
    const settings = {
      settings: {
        workflowScheduler: {
          lastCheckAt: new Date(2026, 7, 9, 0, 0, 0, 0).getTime()
        }
      },
      saveSettings: jest.fn(async () => undefined)
    };
    const workflowScheduleService = new WorkflowScheduleService({
      plugin,
      settings: settings as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['settings'],
      workspaceService: workspaceService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['workspaceService'],
      workflowRunService,
      authorityService
    });
    const scheduleStart = jest.spyOn(workflowScheduleService, 'start');
    const getService = jest.fn(async (name: string) => {
      if (name === 'agentRunService') {
        return agentRunService;
      }
      if (name === 'workflowScheduleService') {
        servicesReady = true;
        return workflowScheduleService;
      }
      return null;
    });
    const processor = new BackgroundProcessor({
      plugin: {} as Plugin,
      settings: {} as never,
      serviceManager: {} as never,
      getService: getService as never,
      waitForService: jest.fn() as never,
      isInitialized: () => true
    });

    processor.startBackgroundStartupProcessing();
    expect(claudeCliWorkflowBackend.start).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(processor.hasRunBackgroundStartupProcessing()).toBe(true);
    await expect(scheduleStart.mock.results[0]?.value).resolves.toBeUndefined();
    expect(plugin.registerInterval).toHaveBeenCalledTimes(1);
    expect(chatService.createConversation).toHaveBeenCalledTimes(1);
    expect(conversations.size).toBe(1);
    await expect(agentRunService.get('conversation-1')).resolves.toEqual(
      expect.objectContaining({ runId: 'conversation-1', status: 'running' })
    );
    expect(claudeCliWorkflowBackend.start).toHaveBeenCalledTimes(1);
    expect(backendStartReadiness).toEqual([true]);
  });
});
