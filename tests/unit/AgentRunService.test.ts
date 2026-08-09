import type { ConversationData } from '../../src/types/chat/ChatTypes';
import type {
  WorkflowExecutionHandle,
  WorkflowExecutionRequest,
  WorkflowExecutionResult
} from '../../src/services/workflows/WorkflowExecutionBackend';
import {
  AgentRunService,
  transitionAgentRun,
  type AgentRunConversationStore,
  type AgentRunStartRequest
} from '../../src/services/workflows/AgentRunService';
import type {
  ApprovalRequest,
  VaultChangeApplyResult
} from '../../src/services/workflows/VaultChangeApplier';
import {
  hashVaultChangePlan,
  parseVaultChangePlan
} from '../../src/services/workflows/VaultChangePlan';
import type { AgentRunMetadata, AgentRunRecord } from '../../src/services/workflows/types';
import { ConversationManager as PersistentConversationManager } from '../../src/services/chat/ConversationManager';

const PROMPT_HASH = `sha256:${'a'.repeat(64)}`;
const WORKFLOW_HASH = `sha256:${'b'.repeat(64)}`;

interface DeferredBackend {
  start: jest.Mock<WorkflowExecutionHandle, [WorkflowExecutionRequest]>;
  request(): WorkflowExecutionRequest;
  resolve(result: Partial<WorkflowExecutionResult> & Pick<WorkflowExecutionResult, 'status'>): void;
}

function createDeferredBackend(): DeferredBackend {
  let lastRequest: WorkflowExecutionRequest | null = null;
  let resolveResult: ((result: WorkflowExecutionResult) => void) | null = null;

  const start = jest.fn((request: WorkflowExecutionRequest): WorkflowExecutionHandle => {
    lastRequest = request;
    const result = new Promise<WorkflowExecutionResult>(resolve => {
      resolveResult = resolve;
    });
    return {
      runId: request.runId,
      result,
      cancel: jest.fn(async () => {
        resolveResult?.(executionResult(request.runId, 'cancelled'));
      })
    };
  });

  return {
    start,
    request: () => {
      if (!lastRequest) {
        throw new Error('Expected the backend to have started');
      }
      return lastRequest;
    },
    resolve: result => {
      if (!lastRequest || !resolveResult) {
        throw new Error('Expected the backend to have started');
      }
      resolveResult({
        ...executionResult(lastRequest.runId, result.status),
        ...result
      });
    }
  };
}

function executionResult(
  runId: string,
  status: WorkflowExecutionResult['status']
): WorkflowExecutionResult {
  return {
    runId,
    status,
    securityBlocked: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: status === 'completed' ? 0 : 1,
    durationMs: 25
  };
}

function createConversationStore(
  initial: ConversationData[] = [conversation('conversation-1')]
): AgentRunConversationStore & {
  conversations: Map<string, ConversationData>;
  getConversation: jest.Mock;
  addMessage: jest.Mock;
  mutateConversationMetadata: jest.Mock;
  listConversationsWithMetadata: jest.Mock;
} {
  const conversations = new Map(initial.map(item => [item.id, item]));
  const addMessage = jest.fn(async (params: {
    conversationId: string;
    role: 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }) => {
    const current = conversations.get(params.conversationId);
    if (!current) {
      throw new Error('missing conversation');
    }
    current.messages.push({
      id: `message-${current.messages.length + 1}`,
      conversationId: current.id,
      role: params.role,
      content: params.content,
      timestamp: 100 + current.messages.length,
      metadata: params.metadata
    });
  });
  const getConversation = jest.fn(async (id: string) => conversations.get(id) ?? null);
  const mutateConversationMetadata = jest.fn(async (
    conversationId: string,
    mutate: (
      current: Readonly<NonNullable<ConversationData['metadata']>>
    ) => NonNullable<ConversationData['metadata']> | null
  ) => {
    const current = conversations.get(conversationId);
    if (!current) {
      throw new Error('missing conversation');
    }
    const metadata = mutate(current.metadata ?? {});
    if (metadata === null) {
      return { applied: false };
    }
    current.metadata = metadata;
    return { applied: true, metadata };
  });
  const listConversationsWithMetadata = jest.fn(async () => Array.from(conversations.values()));

  return {
    conversations,
    getConversation,
    listConversationsWithMetadata,
    addMessage,
    mutateConversationMetadata
  };
}

function conversation(id: string, agentRun?: AgentRunMetadata): ConversationData {
  return {
    id,
    title: `Run ${id}`,
    messages: [],
    created: 1,
    updated: 1,
    metadata: {
      chatSettings: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      unrelated: { keep: true },
      ...(agentRun ? { agentRun } : {})
    }
  };
}

function startRequest(overrides: Partial<AgentRunStartRequest> = {}): AgentRunStartRequest {
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

  return {
    conversationId: 'conversation-1',
    workspaceId: 'workspace-1',
    workflow: {
      id: 'workflow-1',
      name: 'Vault hygiene',
      when: 'On demand',
      steps: 'Inspect evidence and propose bounded operations.',
      promptId: 'prompt-1',
      execution
    },
    execution,
    resolvedPrompt: 'Resolved CLAUDE.md, workspace, and saved prompt instructions.',
    runTrigger: 'manual',
    scheduledFor: 123,
    runKey: 'workspace-1:workflow-1:123',
    deviceId: 'device-a',
    ...overrides
  };
}

function runMetadata(status: AgentRunMetadata['status']): AgentRunMetadata {
  return {
    backend: 'claude-cli',
    authorityScope: 'vault-synced',
    deviceId: 'device-a',
    status,
    trigger: 'manual',
    model: 'sonnet',
    mode: 'proposal',
    capabilityProfile: 'vault-readonly',
    outputSchema: 'vault-change-plan/v1',
    approvalRequired: true,
    maxTurns: 12,
    timeoutMinutes: 10,
    workspaceId: 'workspace-1',
    workflowId: 'workflow-1',
    workflowName: 'Vault hygiene',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    queuedAt: 1,
    ...(status === 'running' ? { startedAt: 2 } : {})
  };
}

function validPlanText(runId = 'conversation-1'): string {
  return JSON.stringify({
    schema: 'vault-change-plan/v1',
    planId: 'plan-1',
    runId,
    workflowId: 'workflow-1',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    workspaceId: 'workspace-1',
    summary: 'No mutation is needed.',
    findings: [],
    evidenceReferences: [],
    operations: [],
    recommendations: [],
    preservationNotes: []
  });
}

function approvalPlanText(): string {
  return JSON.stringify({
    schema: 'vault-change-plan/v1',
    planId: 'plan-approval',
    runId: 'conversation-1',
    workflowId: 'workflow-1',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    workspaceId: 'workspace-1',
    summary: 'Apply one approved property change.',
    findings: [{ findingId: 'finding-1', summary: 'Status is stale.', evidence: ['evidence-1'] }],
    evidenceReferences: [{ evidenceId: 'evidence-1', path: 'note.md', excerpt: 'status: todo' }],
    operations: [{
      operationId: 'op-1',
      findingId: 'finding-1',
      type: 'setProperty',
      evidence: ['evidence-1'],
      preconditions: [{ path: 'note.md', exists: true }],
      expectedEffect: 'Set status to done.',
      risk: { level: 'low', explanation: 'Single property replacement.' },
      dependsOn: [],
      rollback: 'Restore the original file bytes.',
      path: 'note.md',
      property: 'status',
      value: 'done'
    }],
    recommendations: [],
    preservationNotes: []
  });
}

function approvableConversation(): { value: ConversationData; planHash: string } {
  const content = approvalPlanText();
  const parsed = parseVaultChangePlan(content, {
    runId: 'conversation-1',
    workflowId: 'workflow-1',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    workspaceId: 'workspace-1'
  });
  const planHash = hashVaultChangePlan(parsed);
  const metadata: AgentRunMetadata = {
    ...runMetadata('awaiting_approval'),
    planHash
  };
  const value = conversation('conversation-1', metadata);
  value.messages.push({
    id: 'message-plan',
    conversationId: value.id,
    role: 'assistant',
    content,
    timestamp: 100,
    metadata: { agentRunEvent: { kind: 'plan', planHash } }
  });
  return { value, planHash };
}

function approvalRequest(planHash: string): ApprovalRequest {
  return {
    runId: 'conversation-1',
    planHash,
    operationIds: ['op-1'],
    approval: { kind: 'human', source: 'nexus-ui', confirmedAt: 1_700_000_000_000 }
  };
}

function createService(
  store = createConversationStore(),
  backend = createDeferredBackend(),
  applyResult: VaultChangeApplyResult = {
    runId: 'conversation-1',
    planHash: `sha256:${'c'.repeat(64)}`,
    status: 'completed',
    operations: []
  }
): {
  service: AgentRunService;
  store: ReturnType<typeof createConversationStore>;
  backend: DeferredBackend;
  applier: { apply: jest.Mock };
} {
  let now = 1_000;
  const hashSnapshot = jest.fn()
    .mockResolvedValueOnce(PROMPT_HASH)
    .mockResolvedValueOnce(WORKFLOW_HASH);
  const applier = {
    apply: jest.fn(async (
      _plan: unknown,
      _request: ApprovalRequest,
      beforeEffects?: () => Promise<void>
    ) => {
      await beforeEffects?.();
      return applyResult;
    })
  };
  return {
    service: new AgentRunService({
      conversations: store,
      backend,
      applier,
      now: () => ++now,
      hashSnapshot
    }),
    store,
    backend,
    applier
  };
}

async function waitForStatus(
  service: AgentRunService,
  runId: string,
  status: AgentRunMetadata['status']
): Promise<AgentRunMetadata> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.resolve();
    const run = await service.get(runId);
    if (run?.status === status) {
      return run;
    }
  }
  throw new Error(`Run ${runId} did not reach ${status}`);
}

describe('AgentRunService', () => {
  it('uses conversationId as runId and appends the immutable valid plan output', async () => {
    const { service, store, backend } = createService();

    const started = await service.start(startRequest());

    expect(started).toMatchObject({ runId: 'conversation-1', status: 'running' });
    expect(backend.request()).toMatchObject({
      runId: 'conversation-1',
      model: 'sonnet',
      maxTurns: 12,
      timeoutMs: 600_000,
      capabilityProfile: 'vault-readonly'
    });
    expect(backend.request().prompt).toContain('Read CLAUDE.md');
    expect(backend.request().prompt).toContain('Resolved CLAUDE.md, workspace, and saved prompt instructions.');
    expect(backend.request().prompt).toContain(`promptHash: ${PROMPT_HASH}`);
    expect(backend.request().prompt).toContain(`workflowHash: ${WORKFLOW_HASH}`);
    expect(backend.request().prompt).toContain('perform no mutation');

    const planText = validPlanText();
    backend.resolve({ status: 'completed', stdout: planText });
    const finished = await waitForStatus(service, 'conversation-1', 'awaiting_approval');

    expect(finished.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.addMessage).toHaveBeenCalledTimes(1);
    expect(store.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      role: 'assistant',
      content: planText
    }));
    expect(store.conversations.get('conversation-1')?.messages[0]?.content).toBe(planText);
    expect(store.conversations.get('conversation-1')?.metadata).toMatchObject({
      unrelated: { keep: true },
      chatSettings: { sessionId: 'session-1' },
      agentRun: { status: 'awaiting_approval' }
    });
    expect(store.conversations.get('conversation-1')?.metadata?.agentRun).not.toHaveProperty('runId');
    expect(store.conversations.get('conversation-1')?.metadata?.agentRun).not.toHaveProperty(
      'conversationId'
    );
    expect(store.mutateConversationMetadata).toHaveBeenCalled();
  });

  it('returns before the backend result settles', async () => {
    const { service } = createService();

    await expect(service.start(startRequest())).resolves.toMatchObject({ status: 'running' });
    await expect(service.get('conversation-1')).resolves.toMatchObject({ status: 'running' });
  });

  it('rejects a requested plan hash that is not bound to the persisted immutable plan', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    const { service, applier } = createService(store);

    await expect(service.approveAndApply({
      ...approvalRequest(seeded.planHash),
      planHash: `sha256:${'f'.repeat(64)}`
    })).rejects.toThrow('plan hash');

    expect(applier.apply).not.toHaveBeenCalled();
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('requires explicit typed human approval context', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    const { service, applier } = createService(store);
    const missingApproval = {
      runId: 'conversation-1',
      planHash: seeded.planHash,
      operationIds: ['op-1']
    } as unknown as ApprovalRequest;

    await expect(service.approveAndApply(missingApproval))
      .rejects.toThrow('explicit human approval context');

    expect(applier.apply).not.toHaveBeenCalled();
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('appends typed approval and operation results around the applying CAS', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    const applyResult: VaultChangeApplyResult = {
      runId: 'conversation-1',
      planHash: seeded.planHash,
      status: 'completed',
      operations: [{
        operationId: 'op-1',
        type: 'setProperty',
        status: 'succeeded',
        startedAt: 1_001,
        finishedAt: 1_002,
        readback: { path: 'note.md', property: 'status', value: 'done' }
      }]
    };
    const { service, applier } = createService(store, createDeferredBackend(), applyResult);

    const result = await service.approveAndApply(approvalRequest(seeded.planHash));

    expect(result).toEqual(applyResult);
    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(store.addMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: JSON.stringify({
        planHash: seeded.planHash,
        operationIds: ['op-1'],
        approval: { kind: 'human', source: 'nexus-ui', confirmedAt: 1_700_000_000_000 }
      }),
      metadata: { agentRunEvent: { kind: 'approval' } }
    }));
    expect(store.addMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: JSON.stringify(applyResult.operations[0]),
      metadata: { agentRunEvent: { kind: 'operation_result', operationId: 'op-1' } }
    }));
    await expect(service.get('conversation-1')).resolves.toMatchObject({
      status: 'completed',
      planHash: seeded.planHash
    });
  });

  it('executes zero effects when approval event persistence fails', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    store.addMessage.mockRejectedValue(new Error('approval append failed'));
    const { service, applier } = createService(store);

    await expect(service.approveAndApply(approvalRequest(seeded.planHash)))
      .rejects.toThrow('approval append failed');

    expect(applier.apply).toHaveBeenCalledTimes(1);
    await expect(service.get('conversation-1')).resolves.toMatchObject({
      status: 'awaiting_approval'
    });
  });

  it('executes zero effects when the applying CAS loses', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    store.mutateConversationMetadata.mockResolvedValue({ applied: false });
    const { service, applier } = createService(store);

    await expect(service.approveAndApply(approvalRequest(seeded.planHash)))
      .rejects.toThrow('applying transition lost');

    expect(applier.apply).toHaveBeenCalledTimes(1);
    await expect(service.get('conversation-1')).resolves.toMatchObject({
      status: 'awaiting_approval'
    });
  });

  it('completes with issues when any selected operation is not succeeded', async () => {
    const seeded = approvableConversation();
    const store = createConversationStore([seeded.value]);
    const applyResult: VaultChangeApplyResult = {
      runId: 'conversation-1',
      planHash: seeded.planHash,
      status: 'completed_with_issues',
      operations: [{
        operationId: 'op-1',
        type: 'setProperty',
        status: 'rolled_back',
        startedAt: 1_001,
        finishedAt: 1_002,
        error: 'authoritative readback failed'
      }]
    };
    const { service } = createService(store, createDeferredBackend(), applyResult);

    await service.approveAndApply(approvalRequest(seeded.planHash));

    await expect(service.get('conversation-1')).resolves.toMatchObject({
      status: 'completed_with_issues'
    });
  });

  it('does not relaunch a persisted run before restart reconciliation', async () => {
    const store = createConversationStore([
      conversation('conversation-1', runMetadata('running'))
    ]);
    const { service, backend } = createService(store);

    await expect(service.start(startRequest())).rejects.toThrow(
      'Agent run already exists: conversation-1'
    );
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('does not overwrite malformed authoritative run metadata during initial CAS', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    store.mutateConversationMetadata.mockImplementation(async (
      conversationId: string,
      mutate: (
        current: Readonly<NonNullable<ConversationData['metadata']>>
      ) => NonNullable<ConversationData['metadata']> | null
    ) => {
      const current = store.conversations.get(conversationId);
      if (!current) throw new Error('missing conversation');
      current.metadata = {
        ...current.metadata,
        agentRun: { status: 'running' } as unknown as AgentRunMetadata
      };
      const metadata = mutate(current.metadata);
      if (metadata === null) return { applied: false };
      current.metadata = metadata;
      return { applied: true, metadata };
    });
    const { service } = createService(store, backend);

    await expect(service.start(startRequest())).rejects.toThrow(
      'Agent run already exists: conversation-1'
    );
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('reserves the conversation before async queueing so concurrent starts cannot duplicate dispatch', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    const service = new AgentRunService({
      conversations: store,
      backend,
      now: () => 1_000,
      hashSnapshot: async snapshot => snapshot.includes('prompt-snapshot')
        ? PROMPT_HASH
        : WORKFLOW_HASH
    });

    const outcomes = await Promise.allSettled([
      service.start(startRequest()),
      service.start(startRequest())
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('freezes workflow and prompt inputs before awaiting snapshot hashes', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    const hashInputs: string[] = [];
    let resolvePromptHash: ((value: string) => void) | null = null;
    const service = new AgentRunService({
      conversations: store,
      backend,
      now: () => 1_000,
      hashSnapshot: jest.fn(async snapshot => {
        hashInputs.push(snapshot);
        if (hashInputs.length === 1) {
          return await new Promise<string>(resolve => {
            resolvePromptHash = resolve;
          });
        }
        return WORKFLOW_HASH;
      })
    });
    const request = startRequest();
    const start = service.start(request);
    for (let turn = 0; turn < 5 && hashInputs.length === 0; turn += 1) {
      await Promise.resolve();
    }

    request.workflow.steps = 'Mutated after start was invoked.';
    resolvePromptHash?.(PROMPT_HASH);
    await start;

    expect(hashInputs[1]).toContain('Inspect evidence and propose bounded operations.');
    expect(hashInputs[1]).not.toContain('Mutated after start was invoked.');
    expect(backend.request().prompt).toContain('Inspect evidence and propose bounded operations.');
    expect(backend.request().prompt).not.toContain('Mutated after start was invoked.');
  });

  it('fails a mismatched backend handle without awaiting its result or cancellation', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    backend.start.mockImplementation(request => ({
      runId: 'different-run',
      result: new Promise<WorkflowExecutionResult>(() => undefined),
      cancel
    }));
    const { service } = createService(store, backend);
    let outcome: AgentRunMetadata['status'] | 'pending' = 'pending';

    void service.start(startRequest()).then(run => {
      outcome = run.status;
    });
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
    }

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('failed');
    await expect(service.get('conversation-1')).resolves.toMatchObject({ status: 'failed' });
  });

  it('rejects a completed result envelope for a different run before attaching its output', async () => {
    const { service, store, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      runId: 'different-run',
      status: 'completed',
      stdout: validPlanText()
    });

    const failed = await waitForStatus(service, 'conversation-1', 'failed');
    expect(failed.status).toBe('failed');
    expect(failed.planHash).toBeUndefined();
    expect(store.addMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      content: validPlanText()
    }));
  });

  it('marks malformed completed output invalid and retains the raw output as a message', async () => {
    const { service, store, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      status: 'completed',
      stdout: 'not a structured plan',
      stderr: 'schema validation diagnostic'
    });
    const finished = await waitForStatus(service, 'conversation-1', 'invalid_output');

    expect(finished.planHash).toBeUndefined();
    expect(store.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      content: 'not a structured plan'
    }));
    expect(store.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      content: 'schema validation diagnostic'
    }));
  });

  it('retains both partial output streams for a timed-out run', async () => {
    const { service, store, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      status: 'timed_out',
      stdout: 'partial stdout',
      stderr: 'timeout stderr'
    });

    await expect(waitForStatus(service, 'conversation-1', 'timed_out')).resolves.toMatchObject({
      status: 'timed_out'
    });
    expect(store.addMessage.mock.calls.map(call => call[0].content)).toEqual([
      'partial stdout',
      'timeout stderr'
    ]);
  });

  it('fails without duplicating a valid plan when its immutable append is rejected', async () => {
    const { service, store, backend } = createService();
    store.addMessage.mockRejectedValue(new Error('append failed'));
    await service.start(startRequest());

    backend.resolve({ status: 'completed', stdout: validPlanText() });
    const finished = await waitForStatus(service, 'conversation-1', 'failed');

    expect(finished.status).toBe('failed');
    expect(store.addMessage).toHaveBeenCalledTimes(2);
    expect(store.addMessage.mock.calls[0][0].content).toBe(validPlanText());
    expect(store.addMessage.mock.calls[1][0].content).toBe('append failed');
  });

  it('does not infer a security denial from untrusted output text', async () => {
    const { service, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      status: 'failed',
      stderr: 'Tool "contentManager_write" is not allowed by capability profile vault-readonly'
    });

    await expect(waitForStatus(service, 'conversation-1', 'failed')).resolves.toMatchObject({
      status: 'failed'
    });
  });

  it('fails closed from the structured security denial even without usable output', async () => {
    const { service, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      status: 'failed',
      securityBlocked: true,
      stdout: '',
      stderr: '',
      stdoutTruncated: true
    });

    await expect(waitForStatus(service, 'conversation-1', 'security_blocked')).resolves.toMatchObject({
      status: 'security_blocked',
      stdoutTruncated: true
    });
  });

  it.each([
    { stdoutTruncated: true, stderrTruncated: false },
    { stdoutTruncated: false, stderrTruncated: true }
  ])('rejects completed output when a stream is truncated: %o', async flags => {
    const { service, backend } = createService();
    await service.start(startRequest());

    backend.resolve({
      status: 'completed',
      stdout: validPlanText(),
      ...flags
    });

    await expect(waitForStatus(service, 'conversation-1', 'invalid_output')).resolves.toMatchObject({
      status: 'invalid_output',
      ...flags
    });
  });

  it('cancels only through the retained handle and records confirmed cancellation', async () => {
    const { service } = createService();
    await service.start(startRequest());

    const cancelled = await service.cancel('conversation-1');

    expect(cancelled.status).toBe('cancelled');
    await expect(service.cancel('conversation-1')).rejects.toThrow('not cancellable');
  });

  it('serializes cancellation of a queued start before backend dispatch', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    let releaseQueued: (() => void) | null = null;
    let reportQueued: (() => void) | null = null;
    const queued = new Promise<void>(resolve => {
      reportQueued = resolve;
    });
    store.mutateConversationMetadata.mockImplementation(async (
      conversationId: string,
      mutate: (
        current: Readonly<NonNullable<ConversationData['metadata']>>
      ) => NonNullable<ConversationData['metadata']> | null
    ) => {
      const current = store.conversations.get(conversationId);
      if (!current) {
        throw new Error('missing conversation');
      }
      const metadata = mutate(current.metadata ?? {});
      if (metadata === null) {
        return { applied: false };
      }
      current.metadata = metadata;
      if (metadata.agentRun?.status === 'queued') {
        reportQueued?.();
        await new Promise<void>(resolve => {
          releaseQueued = resolve;
        });
      }
      return { applied: true, metadata };
    });
    const { service } = createService(store, backend);

    const start = service.start(startRequest());
    await queued;
    const cancel = service.cancel('conversation-1');
    releaseQueued?.();
    const cancelled = await cancel;
    const startResult = await start;

    expect(cancelled.status).toBe('cancelled');
    expect(startResult.status).toBe('cancelled');
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('cancels a start requested before queued metadata exists', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    let releaseConversationRead!: () => void;
    let reportConversationRead!: () => void;
    const conversationRead = new Promise<void>(resolve => { reportConversationRead = resolve; });
    const conversationRelease = new Promise<void>(resolve => { releaseConversationRead = resolve; });
    store.getConversation.mockImplementationOnce(async (id: string) => {
      reportConversationRead();
      await conversationRelease;
      return store.conversations.get(id) ?? null;
    });
    const { service } = createService(store, backend);

    const start = service.start(startRequest());
    await conversationRead;
    const cancel = service.cancel('conversation-1');
    releaseConversationRead();

    await expect(cancel).resolves.toMatchObject({ status: 'cancelled' });
    await expect(start).resolves.toMatchObject({ status: 'cancelled' });
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('terminates the retained handle before surfacing running persistence failure', async () => {
    const store = createConversationStore();
    const backend = createDeferredBackend();
    let releaseResult!: (result: WorkflowExecutionResult) => void;
    const result = new Promise<WorkflowExecutionResult>(resolve => { releaseResult = resolve; });
    const cancel = jest.fn(async () => undefined);
    backend.start.mockImplementation(request => ({ runId: request.runId, result, cancel }));
    store.mutateConversationMetadata.mockImplementation(async (
      conversationId: string,
      mutate: (
        current: Readonly<NonNullable<ConversationData['metadata']>>
      ) => NonNullable<ConversationData['metadata']> | null
    ) => {
      const current = store.conversations.get(conversationId);
      if (!current) throw new Error('missing conversation');
      const metadata = mutate(current.metadata ?? {});
      if (metadata === null) return { applied: false };
      if (metadata.agentRun?.status === 'running') throw new Error('disk');
      current.metadata = metadata;
      return { applied: true, metadata };
    });
    const { service } = createService(store, backend);
    let settled = false;

    const start = service.start(startRequest()).finally(() => { settled = true; });
    for (let turn = 0; turn < 20 && cancel.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseResult(executionResult('conversation-1', 'cancelled'));
    await expect(start).rejects.toThrow('disk');
  });

  it('marks persisted non-terminal conversations interrupted on restart', async () => {
    const store = createConversationStore([
      conversation('run-running', runMetadata('running')),
      conversation('run-queued', runMetadata('queued')),
      conversation('run-finished', runMetadata('completed'))
    ]);
    const { service } = createService(store);

    await service.reconcileInterrupted();

    await expect(service.get('run-running')).resolves.toMatchObject({ status: 'interrupted' });
    await expect(service.get('run-queued')).resolves.toMatchObject({ status: 'interrupted' });
    await expect(service.get('run-finished')).resolves.toMatchObject({ status: 'completed' });
    expect(store.conversations.get('run-running')?.metadata).toMatchObject({
      unrelated: { keep: true },
      agentRun: { status: 'interrupted' }
    });
  });

  it('does not overwrite a concurrently completed run during reconciliation', async () => {
    const store = createConversationStore([
      conversation('conversation-1', runMetadata('running'))
    ]);
    store.mutateConversationMetadata.mockResolvedValue({ applied: false });
    const { service } = createService(store);

    await service.reconcileInterrupted();

    const mutate = store.mutateConversationMetadata.mock.calls[0]?.[1] as (
      current: Readonly<NonNullable<ConversationData['metadata']>>
    ) => NonNullable<ConversationData['metadata']> | null;
    expect(mutate({ agentRun: runMetadata('completed') })).toBeNull();
  });

  it('rejects invalid state transitions in one pure transition function', () => {
    expect(() => transitionAgentRun(runMetadata('running'), 'completed', {}))
      .toThrow('Invalid agent run transition: running -> completed');
    expect(() => transitionAgentRun(runMetadata('completed'), 'running', {}))
      .toThrow('Invalid agent run transition: completed -> running');
  });

  it('keeps public record identity fields outside pure metadata transitions', () => {
    const record: AgentRunRecord & { token: string } = {
      ...runMetadata('running'),
      runId: 'conversation-1',
      conversationId: 'conversation-1',
      token: 'must-not-persist'
    };
    const transitioned = transitionAgentRun(record, 'timed_out', {});

    expect(transitioned).not.toHaveProperty('runId');
    expect(transitioned).not.toHaveProperty('conversationId');
    expect(transitioned).not.toHaveProperty('token');
  });

  it('returns a closed DTO even if persisted metadata contains unknown keys', async () => {
    const contaminated: AgentRunMetadata & { token: string } = {
      ...runMetadata('completed'),
      token: 'must-not-reach-dto'
    };
    const store = createConversationStore([
      conversation('conversation-1', contaminated)
    ]);
    const { service } = createService(store);

    const loaded = await service.get('conversation-1');

    expect(loaded).toMatchObject({ runId: 'conversation-1', status: 'completed' });
    expect(loaded).not.toHaveProperty('token');
  });
});

describe('agent run conversation persistence', () => {
  function createPersistentManager(conversations: ConversationData[]) {
    const byId = new Map(conversations.map(item => [item.id, item]));
    const conversationService = {
      getConversation: jest.fn(async (id: string) => byId.get(id) ?? null),
      listConversations: jest.fn(async (
        _vaultName?: string,
        limit = 100,
        page = 0
      ) => conversations.slice(page * limit, (page + 1) * limit).map(item => ({ id: item.id }))),
      getConversationIdsSnapshot: jest.fn(async () => conversations.map(item => item.id)),
      addMessage: jest.fn(async () => undefined),
      updateConversation: jest.fn(async (id: string, updates: Partial<ConversationData>) => {
        const current = byId.get(id);
        if (!current) throw new Error('missing conversation');
        Object.assign(current, updates);
      }),
      createConversation: jest.fn(async () => conversation('created')),
      deleteConversation: jest.fn(async () => undefined)
    };
    const manager = new PersistentConversationManager({
      conversationService,
      streamingGenerator: async function* () {
        return;
      }
    }, 'Test vault');
    return { manager, conversationService };
  }

  it('replaces only agentRun while preserving concurrently read sibling metadata', async () => {
    const current = conversation('conversation-1');
    current.metadata = {
      chatSettings: { sessionId: 'newer-session' },
      unrelated: { keep: true }
    };
    const { manager, conversationService } = createPersistentManager([current]);

    await manager.mutateConversationMetadata('conversation-1', metadata => ({
      ...metadata,
      agentRun: runMetadata('running')
    }));

    expect(conversationService.updateConversation).toHaveBeenCalledWith('conversation-1', {
      metadata: {
        chatSettings: { sessionId: 'newer-session' },
        unrelated: { keep: true },
        agentRun: runMetadata('running')
      }
    });
  });

  it('serializes metadata mutations and rereads sibling fields at commit time', async () => {
    const current = conversation('conversation-1');
    const { manager, conversationService } = createPersistentManager([current]);
    let releaseFirstWrite!: () => void;
    let reportFirstWrite!: () => void;
    const firstWrite = new Promise<void>(resolve => { reportFirstWrite = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    conversationService.updateConversation.mockImplementationOnce(async (
      id: string,
      updates: Partial<ConversationData>
    ) => {
      reportFirstWrite();
      await firstRelease;
      Object.assign(current, updates);
    });

    const first = manager.mutateConversationMetadata('conversation-1', metadata => ({
      ...metadata,
      agentRun: runMetadata('queued')
    }));
    await firstWrite;
    const second = manager.mutateConversationMetadata('conversation-1', metadata => ({
      ...metadata,
      chatSettings: { ...metadata.chatSettings, sessionId: 'concurrent-session' }
    }));
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(current.metadata).toMatchObject({
      agentRun: { status: 'queued' },
      chatSettings: { sessionId: 'concurrent-session' },
      unrelated: { keep: true }
    });
    expect(conversationService.getConversation).toHaveBeenCalledTimes(2);
  });

  it('rejects a storage result that reports a failed authoritative message append', async () => {
    const { manager, conversationService } = createPersistentManager([
      conversation('conversation-1')
    ]);
    conversationService.addMessage.mockResolvedValue({
      success: false,
      error: 'authoritative append failed'
    });

    await expect(manager.addMessage({
      conversationId: 'conversation-1',
      role: 'assistant',
      content: validPlanText()
    })).rejects.toThrow('authoritative append failed');
  });

  it('hydrates every member of one stable 101-record ID snapshot', async () => {
    const conversations = Array.from({ length: 101 }, (_value, index) =>
      conversation(`conversation-${index}`)
    );
    const { manager, conversationService } = createPersistentManager(conversations);
    conversationService.getConversation.mockImplementation(async (id: string) => {
      const current = conversations.find(item => item.id === id) ?? null;
      if (id === 'conversation-0') {
        conversations[100].updated = Date.now();
      }
      return current;
    });

    const loaded = await manager.listConversationsWithMetadata();

    expect(loaded).toHaveLength(101);
    expect(new Set(loaded.map(item => item.id)).size).toBe(101);
    expect(conversationService.getConversationIdsSnapshot).toHaveBeenCalledTimes(1);
    expect(conversationService.listConversations).not.toHaveBeenCalled();
  });
});
