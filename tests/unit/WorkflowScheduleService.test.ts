/**
 * Tests for WorkflowScheduleService persistence behaviour.
 *
 * The scheduler scans every workspace once a minute looking for workflows whose
 * schedule is due. The scan itself is cheap when nothing is scheduled — the
 * inner loop skips every workflow without `schedule.enabled`. What was not
 * cheap is the `finally` block: it stamped `workflowScheduler.lastCheckAt` and
 * called `saveSettings()` unconditionally, and `saveSettings()` writes the
 * whole settings object over data.json.
 *
 * On a vault with no scheduled workflows at all, that is a full rewrite of
 * data.json every 60 seconds, forever, to persist a timestamp nothing reads.
 * Measured on a real vault: ~22 KB x 1440 writes/day.
 *
 * The fix keeps `lastCheckAt` current in memory on every scan — otherwise it
 * would freeze, and the first workflow created after a long gap would compute
 * due slots from a stale anchor — but only reaches disk when at least one
 * enabled schedule was actually seen.
 */

import { WorkflowScheduleService } from '../../src/services/workflows/WorkflowScheduleService';

interface HarnessOptions {
  workspaces?: unknown[];
  lastCheckAt?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const saveSettings = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const settings = {
    settings: {
      workflowScheduler: options.lastCheckAt === undefined
        ? undefined
        : { lastCheckAt: options.lastCheckAt }
    },
    saveSettings
  };

  const start = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);

  const service = new WorkflowScheduleService({
    plugin: { registerInterval: jest.fn() },
    settings,
    workspaceService: {
      getAllWorkspaces: jest.fn().mockResolvedValue(options.workspaces ?? [])
    },
    conversationService: { hasRunKey: jest.fn().mockResolvedValue(false) },
    workflowRunService: { start }
  } as unknown as ConstructorParameters<typeof WorkflowScheduleService>[0]);

  return { service, saveSettings, settings, runStart: start };
}

/** A workspace carrying one workflow with an enabled hourly schedule. */
function workspaceWithSchedule() {
  return {
    id: 'ws-1',
    isActive: true,
    context: {
      workflows: [
        { id: 'wf-1', schedule: { enabled: true, frequency: 'hourly', minute: 0 } }
      ]
    }
  };
}

/** Same shape, but the schedule is switched off — the scan must skip it. */
function workspaceWithDisabledSchedule() {
  return {
    id: 'ws-2',
    isActive: true,
    context: {
      workflows: [
        { id: 'wf-2', schedule: { enabled: false, frequency: 'hourly', minute: 0 } }
      ]
    }
  };
}

describe('WorkflowScheduleService — settings are only written when there is something to schedule', () => {
  it('does not touch disk across repeated scans when no workflow is scheduled', async () => {
    const { service, saveSettings } = createHarness({
      workspaces: [{ id: 'ws-1', isActive: true, context: { workflows: [] } }],
      lastCheckAt: 1_000
    });

    for (let i = 0; i < 5; i += 1) {
      await service.scanDueWorkflows(false);
    }

    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('does not write for a workflow whose schedule is disabled', async () => {
    const { service, saveSettings } = createHarness({
      workspaces: [workspaceWithDisabledSchedule()],
      lastCheckAt: 1_000
    });

    await service.scanDueWorkflows(false);

    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('keeps lastCheckAt current in memory even when it does not persist', async () => {
    const { service, settings } = createHarness({
      workspaces: [{ id: 'ws-1', isActive: true, context: { workflows: [] } }],
      lastCheckAt: 1_000
    });

    await service.scanDueWorkflows(false);

    const stamped = settings.settings.workflowScheduler?.lastCheckAt;
    expect(stamped).toBeDefined();
    expect(stamped).toBeGreaterThan(1_000);
  });

  it('still writes when an enabled schedule is present', async () => {
    const { service, saveSettings } = createHarness({
      workspaces: [workspaceWithSchedule()],
      lastCheckAt: 1_000
    });

    await service.scanDueWorkflows(false);

    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('writes when one workspace among several carries an enabled schedule', async () => {
    const { service, saveSettings } = createHarness({
      workspaces: [
        { id: 'ws-0', isActive: true, context: { workflows: [] } },
        workspaceWithDisabledSchedule(),
        workspaceWithSchedule()
      ],
      lastCheckAt: 1_000
    });

    await service.scanDueWorkflows(false);

    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('ignores a scheduled workflow inside an inactive workspace', async () => {
    const inactive = { ...workspaceWithSchedule(), isActive: false };
    const { service, saveSettings } = createHarness({
      workspaces: [inactive],
      lastCheckAt: 1_000
    });

    await service.scanDueWorkflows(false);

    expect(saveSettings).not.toHaveBeenCalled();
  });
});
