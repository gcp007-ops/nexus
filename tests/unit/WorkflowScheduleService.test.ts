import type { Plugin } from 'obsidian';
import { BackgroundProcessor } from '../../src/core/background/BackgroundProcessor';
import { WorkflowScheduleService } from '../../src/services/workflows/WorkflowScheduleService';
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
  const service = new WorkflowScheduleService({
    plugin,
    settings: settings as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['settings'],
    workspaceService: workspaceService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['workspaceService'],
    conversationService: conversationService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['conversationService'],
    workflowRunService: workflowRunService as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]['workflowRunService']
  });

  return {
    service,
    plugin,
    settings,
    workflowRunService,
    workspaceService,
    conversationService
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

  it('preserves runKey deduplication before dispatch', async () => {
    const { service, workflowRunService, conversationService } = createHarness(async () => ({
      conversationId: 'conversation-1'
    }));
    conversationService.hasRunKey.mockResolvedValue(true);

    await service.scanDueWorkflows(false);

    expect(conversationService.hasRunKey).toHaveBeenCalledWith(
      `workspace-1:workflow-1:${DUE_SLOT}`
    );
    expect(workflowRunService.start).not.toHaveBeenCalled();
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
});
