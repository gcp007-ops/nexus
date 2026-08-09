import type { Plugin } from 'obsidian';
import { BackgroundProcessor } from '../../src/core/background/BackgroundProcessor';
import { WorkflowScheduleService } from '../../src/services/workflows/WorkflowScheduleService';
import { WorkflowRunConflictError } from '../../src/services/workflows/WorkflowRunReservationService';
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
    const never = new Promise<never>(() => undefined);
    const backendStartReadiness: boolean[] = [];
    let servicesReady = false;
    let backgroundStartupCompleted = false;
    const claudeCliWorkflowBackend = {
      start: jest.fn(() => {
        backendStartReadiness.push(servicesReady);
        return never;
      })
    };
    const { service, plugin, settings, workflowRunService } = createHarness(
      () => claudeCliWorkflowBackend.start()
    );
    settings.settings.workflowScheduler.lastCheckAt = new Date(2026, 7, 9, 0, 0, 0, 0).getTime();
    const agentRunService = {
      reconcileInterrupted: jest.fn(async () => undefined)
    };
    const workflowScheduleService = {
      start: jest.fn(async () => {
        await service.start();
        backgroundStartupCompleted = true;
      })
    };
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

    jest.advanceTimersByTime(2_000);
    await flushMicrotasks();

    expect(backgroundStartupCompleted).toBe(true);
    expect(processor.hasRunBackgroundStartupProcessing()).toBe(true);
    expect(plugin.registerInterval).toHaveBeenCalledTimes(1);
    expect(workflowRunService.start).toHaveBeenCalledTimes(1);
    expect(claudeCliWorkflowBackend.start).toHaveBeenCalledTimes(1);
    expect(backendStartReadiness).toEqual([true]);
  });
});
