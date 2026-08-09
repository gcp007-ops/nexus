import type { ConversationData } from '../../src/types/chat/ChatTypes';
import type { AgentRunRecord } from '../../src/services/workflows/types';
import type { ApprovalRequest } from '../../src/services/workflows/VaultChangeApplier';
import {
  SupervisedWorkflowService,
  type SupervisedWorkflowServiceDependencies
} from '../../src/services/workflows/SupervisedWorkflowService';

const PROMPT_HASH = `sha256:${'a'.repeat(64)}`;
const WORKFLOW_HASH = `sha256:${'b'.repeat(64)}`;
const PLAN_HASH = `sha256:${'c'.repeat(64)}`;

function run(status: AgentRunRecord['status'] = 'running'): AgentRunRecord {
  return {
    runId: 'run-1',
    conversationId: 'run-1',
    backend: 'claude-cli',
    authorityScope: 'vault-synced',
    deviceId: 'private-device-id',
    status,
    trigger: 'manual',
    model: 'sonnet',
    mode: 'proposal',
    capabilityProfile: 'vault-readonly',
    outputSchema: 'vault-change-plan/v1',
    approvalRequired: true,
    maxTurns: 12,
    timeoutMinutes: 10,
    workspaceId: 'ws-1',
    workflowId: 'wf-supervised',
    workflowName: 'Vault hygiene',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    queuedAt: 100,
    startedAt: 110,
    ...(status === 'awaiting_approval' ? { finishedAt: 150, durationMs: 40, planHash: PLAN_HASH } : {})
  };
}

function conversation(status: AgentRunRecord['status'] = 'running'): ConversationData {
  const record = run(status);
  return {
    id: record.runId,
    title: 'Private mutable conversation',
    created: 90,
    updated: 150,
    metadata: {
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      promptId: 'prompt-1',
      capabilityToken: 'must-never-leak',
      resolvedPrompt: 'must-never-leak',
      agentRun: record
    },
    messages: status === 'awaiting_approval' ? [{
      id: 'message-plan',
      conversationId: record.runId,
      role: 'assistant',
      timestamp: 145,
      content: JSON.stringify({
        schema: 'vault-change-plan/v1',
        planId: 'plan-1',
        runId: record.runId,
        workflowId: record.workflowId,
        promptHash: PROMPT_HASH,
        workflowHash: WORKFLOW_HASH,
        workspaceId: record.workspaceId,
        summary: 'Archive stale note.',
        findings: [{ findingId: 'finding-1', summary: 'Stale note', evidence: ['evidence-1'] }],
        evidenceReferences: [{ evidenceId: 'evidence-1', path: 'Inbox/Stale.md', excerpt: 'status: done' }],
        operations: [{
          operationId: 'archive-1',
          findingId: 'finding-1',
          type: 'archive',
          path: 'Inbox/Stale.md',
          evidence: ['evidence-1'],
          preconditions: [{ path: 'Inbox/Stale.md', exists: true }],
          expectedEffect: 'Move note to the archive.',
          risk: { level: 'low', explanation: 'Reversible move.' },
          dependsOn: [],
          rollback: 'Move the note back.'
        }],
        recommendations: [],
        preservationNotes: ['Keep links valid.']
      }),
      metadata: { agentRunEvent: { kind: 'plan', planHash: PLAN_HASH } }
    }] : []
  };
}

function makeDependencies(): SupervisedWorkflowServiceDependencies & {
  workflowRunService: { start: jest.Mock };
  agentRunService: {
    get: jest.Mock;
    list: jest.Mock;
    cancel: jest.Mock;
    approveAndApply: jest.Mock;
  };
  openRun: jest.Mock;
  openWorkflow: jest.Mock;
} {
  const workflows = [{
    id: 'ws-1',
    name: 'Developer',
    rootFolder: '/',
    created: 1,
    lastAccessed: 1,
    context: {
      workflows: [{
        id: 'wf-chat',
        name: 'Chat workflow',
        when: 'Asked',
        steps: 'Discuss.'
      }, {
        id: 'wf-supervised',
        name: 'Vault hygiene',
        when: 'On demand',
        steps: 'Inspect and propose.',
        promptId: 'prompt-1',
        promptName: 'Vault curator',
        execution: {
          backend: 'claude-cli' as const,
          authorityScope: 'vault-synced' as const,
          authorityDeviceId: 'private-device-id',
          model: 'sonnet',
          mode: 'proposal' as const,
          capabilityProfile: 'vault-readonly' as const,
          outputSchema: 'vault-change-plan/v1' as const,
          maxTurns: 12,
          timeoutMinutes: 10,
          approvalRequired: true as const
        }
      }]
    }
  }];
  const workflowRunService = {
    start: jest.fn().mockResolvedValue({ conversationId: 'run-1', runId: 'run-1' })
  };
  const agentRunService = {
    get: jest.fn().mockResolvedValue(run()),
    list: jest.fn().mockResolvedValue([run()]),
    cancel: jest.fn().mockResolvedValue(run('cancelled')),
    approveAndApply: jest.fn().mockResolvedValue({
      runId: 'run-1', planHash: PLAN_HASH, status: 'completed', operations: []
    })
  };
  return {
    workspaceService: {
      getAllWorkspaces: jest.fn().mockResolvedValue(workflows),
      getWorkspace: jest.fn(async (id: string) => workflows.find(item => item.id === id) ?? null)
    },
    workflowRunService,
    agentRunService,
    conversationService: {
      getConversation: jest.fn().mockImplementation(async () => conversation())
    },
    authorityService: {
      assertCanRun: jest.fn().mockReturnValue('private-device-id')
    },
    getBackendPreflight: jest.fn().mockResolvedValue({
      claudePath: '/private/bin/claude',
      nodePath: '/private/bin/node',
      connectorPath: '/private/plugin/connector.js',
      vaultPath: '/private/vault',
      isAuthenticated: true,
      authStatusText: 'authenticated'
    }),
    isDesktop: () => true,
    openRun: jest.fn().mockResolvedValue(undefined),
    openWorkflow: jest.fn().mockResolvedValue(undefined)
  };
}

describe('SupervisedWorkflowService', () => {
  it('lists only compatible Claude proposal workflows as closed summaries', async () => {
    const service = new SupervisedWorkflowService(makeDependencies());

    await expect(service.listWorkflows()).resolves.toEqual([{
      workspaceId: 'ws-1',
      workspaceName: 'Developer',
      workflowId: 'wf-supervised',
      workflowName: 'Vault hygiene',
      when: 'On demand',
      prompt: { id: 'prompt-1', name: 'Vault curator' },
      model: 'sonnet',
      scheduleEnabled: false
    }]);
  });

  it('returns path-free readiness and rejects chat workflow preflight clearly', async () => {
    const service = new SupervisedWorkflowService(makeDependencies());

    await expect(service.getPreflight('wf-supervised')).resolves.toEqual({
      workflowId: 'wf-supervised',
      ready: true,
      checks: {
        desktop: true,
        claudeAvailable: true,
        nodeAvailable: true,
        connectorAvailable: true,
        vaultAvailable: true,
        authenticated: true,
        authority: true
      },
      issues: []
    });
    await expect(service.getPreflight('wf-chat')).rejects.toThrow(
      'Workflow is not a compatible supervised Claude workflow: wf-chat'
    );
    expect(JSON.stringify(await service.getPreflight('wf-supervised'))).not.toContain('/private/');
  });

  it('starts through the authority-gated runtime and returns its run id without waiting for completion', async () => {
    const dependencies = makeDependencies();
    const service = new SupervisedWorkflowService(dependencies);

    await expect(service.start({ workspaceId: 'ws-1', workflowId: 'wf-supervised' }))
      .resolves.toEqual({ runId: 'run-1' });
    expect(dependencies.workflowRunService.start).toHaveBeenCalledWith({
      workspaceId: 'ws-1', workflowId: 'wf-supervised', openInChat: false
    });
  });

  it('rejects attempts to start chat workflows instead of preserving a second path', async () => {
    const service = new SupervisedWorkflowService(makeDependencies());
    await expect(service.start({ workspaceId: 'ws-1', workflowId: 'wf-chat' }))
      .rejects.toThrow('Workflow is not a compatible supervised Claude workflow: wf-chat');
  });

  it('returns an immutable plain run DTO without internal authority, tokens, paths, or conversation objects', async () => {
    const dependencies = makeDependencies();
    dependencies.agentRunService.get.mockResolvedValue(run('awaiting_approval'));
    (dependencies.conversationService.getConversation as jest.Mock)
      .mockResolvedValue(conversation('awaiting_approval'));
    const service = new SupervisedWorkflowService(dependencies);

    const result = await service.getRun('run-1');

    expect(result.status).toBe('awaiting_approval');
    expect(result.planValidation).toEqual({ status: 'valid' });
    expect(result.plan?.operations).toHaveLength(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('capabilityToken');
    expect(serialized).not.toContain('private-device-id');
    expect(serialized).not.toContain('resolvedPrompt');
    expect(serialized).not.toContain('/private/');
    result.workflow.name = 'Changed outside';
    expect(conversation('awaiting_approval').metadata?.workflowName).toBe('Vault hygiene');
  });

  it('projects durable application receipts through a closed operation DTO', async () => {
    const dependencies = makeDependencies();
    const stored = conversation('awaiting_approval');
    stored.metadata = {
      ...stored.metadata,
      agentRunApplyReceipt: {
        schema: 'agent-run-apply-receipt/v1',
        runId: 'run-1',
        planHash: PLAN_HASH,
        operationIds: ['archive-1', 'property-1', 'replace-1'],
        operations: [{
          operationId: 'archive-1',
          type: 'archive',
          status: 'succeeded',
          startedAt: 160,
          finishedAt: 170,
          readback: {
            sourcePath: 'Inbox/Stale.md',
            sourceExists: false,
            destinationPath: '.archive/2026-08-09/Inbox/Stale.md',
            destinationExists: true,
            capabilityToken: 'nested-secret',
            resolvedPrompt: 'nested-prompt-text',
            connectorPath: '/private/plugin/connector.js',
            childHandle: { pid: 123 },
            extra: { env: { API_KEY: 'nested-env-secret' } }
          },
          capabilityToken: 'must-never-leak',
          childHandle: { pid: 123 }
        }, {
          operationId: 'property-1',
          type: 'setProperty',
          status: 'rolled_back',
          startedAt: 171,
          finishedAt: 180,
          readback: {
            path: 'Projects/Case.md',
            property: 'status',
            valuePresent: false,
            value: { resolvedPrompt: 'must-not-cross' },
            contentHash: `sha256:${'d'.repeat(64)}`,
            configPath: '/private/config.json'
          },
          error: 'Authoritative readback failed.'
        }, {
          operationId: 'replace-1',
          type: 'replaceAnchored',
          status: 'rollback_failed',
          startedAt: 181,
          finishedAt: 190,
          readback: {
            path: 'Projects/Case.md',
            contentHash: `sha256:${'e'.repeat(64)}`,
            handle: { pid: 999 }
          },
          error: 'Readback failed.',
          rollbackError: 'Rollback failed.'
        }]
      }
    };
    dependencies.agentRunService.get.mockResolvedValue(run('awaiting_approval'));
    (dependencies.conversationService.getConversation as jest.Mock).mockResolvedValue(stored);
    const service = new SupervisedWorkflowService(dependencies);

    const result = await service.getRun('run-1');

    expect(result.application?.operations).toEqual([{
      operationId: 'archive-1',
      type: 'archive',
      status: 'succeeded',
      startedAt: 160,
      finishedAt: 170,
      readback: {
        sourcePath: 'Inbox/Stale.md',
        sourceExists: false,
        destinationPath: '.archive/2026-08-09/Inbox/Stale.md',
        destinationExists: true
      }
    }, {
      operationId: 'property-1',
      type: 'setProperty',
      status: 'rolled_back',
      startedAt: 171,
      finishedAt: 180,
      readback: {
        path: 'Projects/Case.md',
        property: 'status',
        valuePresent: false,
        contentHash: `sha256:${'d'.repeat(64)}`
      },
      error: 'Authoritative readback failed.'
    }, {
      operationId: 'replace-1',
      type: 'replaceAnchored',
      status: 'rollback_failed',
      startedAt: 181,
      finishedAt: 190,
      readback: {
        path: 'Projects/Case.md',
        contentHash: `sha256:${'e'.repeat(64)}`
      },
      error: 'Readback failed.',
      rollbackError: 'Rollback failed.'
    }]);
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
    expect(JSON.stringify(result)).not.toContain('childHandle');
    expect(JSON.stringify(result)).not.toContain('nested-secret');
    expect(JSON.stringify(result)).not.toContain('nested-prompt-text');
    expect(JSON.stringify(result)).not.toContain('/private/');
    expect(JSON.stringify(result)).not.toContain('nested-env-secret');
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
  });

  it('filters active runs without inventing another lifecycle', async () => {
    const dependencies = makeDependencies();
    dependencies.agentRunService.list.mockResolvedValue([
      run('running'),
      { ...run('completed'), runId: 'run-2', conversationId: 'run-2' }
    ]);
    (dependencies.conversationService.getConversation as jest.Mock).mockImplementation(
      async (id: string) => ({ ...conversation(id === 'run-1' ? 'running' : 'completed'), id })
    );
    const service = new SupervisedWorkflowService(dependencies);

    const result = await service.listRuns({ activeOnly: true });
    expect(result.map(item => item.runId)).toEqual(['run-1']);
  });

  it('delegates cancellation and exact approval to AgentRunService before authoritative readback', async () => {
    const dependencies = makeDependencies();
    const service = new SupervisedWorkflowService(dependencies);
    const approval: ApprovalRequest = {
      runId: 'run-1',
      planHash: PLAN_HASH,
      operationIds: ['archive-1'],
      approval: { kind: 'human', source: 'thinkbox', confirmedAt: 200 }
    };

    await service.cancel('run-1');
    await service.approveAndApply(approval);

    expect(dependencies.agentRunService.cancel).toHaveBeenCalledWith('run-1');
    expect(dependencies.agentRunService.approveAndApply).toHaveBeenCalledWith(approval);
    expect(dependencies.agentRunService.get).toHaveBeenCalledTimes(2);
  });

  it('returns authoritative rejected readback after cancelling an awaiting proposal', async () => {
    const dependencies = makeDependencies();
    dependencies.agentRunService.cancel.mockResolvedValue(run('rejected'));
    dependencies.agentRunService.get.mockResolvedValue(run('rejected'));
    (dependencies.conversationService.getConversation as jest.Mock)
      .mockResolvedValue(conversation('rejected'));
    const service = new SupervisedWorkflowService(dependencies);

    await expect(service.cancel('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      status: 'rejected'
    });
    expect(dependencies.agentRunService.cancel).toHaveBeenCalledWith('run-1');
    expect(dependencies.agentRunService.get).toHaveBeenCalledWith('run-1');
  });

  it('delegates navigation to the single production surfaces', async () => {
    const dependencies = makeDependencies();
    const service = new SupervisedWorkflowService(dependencies);

    await service.openRun('run-1');
    await service.openWorkflow('ws-1', 'wf-supervised');

    expect(dependencies.openRun).toHaveBeenCalledWith('run-1');
    expect(dependencies.openWorkflow).toHaveBeenCalledWith('ws-1', 'wf-supervised');
  });

  it('fails closed before navigating to an incompatible workflow', async () => {
    const dependencies = makeDependencies();
    const service = new SupervisedWorkflowService(dependencies);

    await expect(service.openWorkflow('ws-1', 'wf-chat')).rejects.toThrow(
      'Workflow is not a compatible supervised Claude workflow: wf-chat'
    );
    expect(dependencies.openWorkflow).not.toHaveBeenCalled();
  });
});
