import type { App } from 'obsidian';
import { NEXUS_DEVICE_ID_STORAGE_KEY } from '../../src/database/storage/JSONLWriter';
import type { WorkflowExecutionConfig } from '../../src/database/types/workspace/WorkspaceTypes';
import { WorkflowAuthorityService } from '../../src/services/workflows/WorkflowAuthorityService';

function makeExecution(overrides: Partial<WorkflowExecutionConfig> = {}): WorkflowExecutionConfig {
  return {
    backend: 'claude-cli',
    authorityScope: 'vault-synced',
    authorityDeviceId: 'device-a',
    model: 'sonnet',
    mode: 'proposal',
    capabilityProfile: 'vault-readonly',
    outputSchema: 'vault-change-plan/v1',
    maxTurns: 12,
    timeoutMinutes: 10,
    approvalRequired: true,
    ...overrides
  };
}

function appWithDeviceId(deviceId: unknown): Pick<App, 'loadLocalStorage'> & {
  loadLocalStorage: jest.Mock;
} {
  return {
    loadLocalStorage: jest.fn((key: string) =>
      key === NEXUS_DEVICE_ID_STORAGE_KEY ? deviceId : undefined)
  };
}

describe('WorkflowAuthorityService', () => {
  it('accepts only the configured vault authority device', () => {
    const app = appWithDeviceId('device-a');
    const authority = new WorkflowAuthorityService(app);

    expect(authority.assertCanRun(makeExecution({ authorityDeviceId: 'device-a' })))
      .toBe('device-a');
    expect(() => authority.assertCanRun(makeExecution({ authorityDeviceId: 'device-b' })))
      .toThrow('Workflow authority device mismatch');
    expect(app.loadLocalStorage).toHaveBeenCalledWith(NEXUS_DEVICE_ID_STORAGE_KEY);
  });

  it('fails closed when vault authority is absent or local identity is unavailable', () => {
    expect(() => new WorkflowAuthorityService(appWithDeviceId('device-a'))
      .assertCanRun(makeExecution({ authorityDeviceId: '   ' })))
      .toThrow('Workflow authority device is required');
    expect(() => new WorkflowAuthorityService(appWithDeviceId(undefined))
      .assertCanRun(makeExecution()))
      .toThrow('Local Nexus device identity is unavailable');
  });

  it('keeps machine-local execution report-only', () => {
    const authority = new WorkflowAuthorityService(appWithDeviceId('device-a'));

    expect(() => authority.assertCanRun(makeExecution({ authorityScope: 'machine-local' })))
      .toThrow('Machine-local workflow execution is not supported');
  });
});
