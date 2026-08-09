import { normalizeWorkspaceData } from '../../src/services/helpers/WorkspaceNormalizer';
import type { IndividualWorkspace } from '../../src/types/storage/StorageTypes';

function makeWorkspace(execution: unknown): IndividualWorkspace {
  return {
    id: 'workspace-1',
    context: {
      workflows: [{
        id: 'workflow-1',
        name: 'Vault hygiene',
        when: 'on demand',
        steps: 'Inspect the vault',
        execution,
      }],
    },
  } as unknown as IndividualWorkspace;
}

function firstWorkflow(workspace: IndividualWorkspace): Record<string, unknown> {
  const workflows = workspace.context?.workflows;
  if (!workflows?.[0]) {
    throw new Error('Expected a workflow');
  }
  return workflows[0] as unknown as Record<string, unknown>;
}

describe('workflow execution normalization', () => {
  it('preserves chat behavior when execution is absent', () => {
    const workspace = makeWorkspace(undefined);

    normalizeWorkspaceData(workspace);

    expect(firstWorkflow(workspace).execution).toBeUndefined();
  });

  it('normalizes a claude-cli proposal backend', () => {
    const workspace = makeWorkspace({
      backend: 'claude-cli',
      model: ' sonnet ',
      mode: 'proposal',
      capabilityProfile: 'vault-readonly',
      outputSchema: 'vault-change-plan/v1',
      maxTurns: 99,
      timeoutMinutes: 0,
      approvalRequired: true,
    });

    normalizeWorkspaceData(workspace);

    expect(firstWorkflow(workspace).execution).toEqual({
      backend: 'claude-cli',
      authorityScope: 'vault-synced',
      model: 'sonnet',
      mode: 'proposal',
      capabilityProfile: 'vault-readonly',
      outputSchema: 'vault-change-plan/v1',
      maxTurns: 40,
      timeoutMinutes: 1,
      approvalRequired: true,
    });
  });

  it('preserves an explicitly assigned vault authority device', () => {
    const workspace = makeWorkspace({
      backend: 'claude-cli',
      authorityScope: 'vault-synced',
      authorityDeviceId: ' device-a ',
      mode: 'proposal',
      capabilityProfile: 'vault-readonly',
      outputSchema: 'vault-change-plan/v1',
      maxTurns: 12,
      timeoutMinutes: 10,
      approvalRequired: true,
    });

    normalizeWorkspaceData(workspace);

    expect(firstWorkflow(workspace).execution).toEqual(expect.objectContaining({
      authorityScope: 'vault-synced',
      authorityDeviceId: 'device-a',
    }));
  });

  it('drops an invalid execution block instead of converting a legacy workflow', () => {
    const workspace = makeWorkspace({ backend: 'claude-cli' });

    normalizeWorkspaceData(workspace);

    expect(firstWorkflow(workspace).execution).toBeUndefined();
  });
});
