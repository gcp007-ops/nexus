import type {
  WorkflowExecutionConfig,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';
import type { ConversationData } from '../../types/chat/ChatTypes';
import { NamedLocks } from '../../utils/AsyncLock';
import {
  hashVaultChangePlan,
  parseVaultChangePlan,
  type ExpectedPlanIdentity
} from './VaultChangePlan';
import type {
  WorkflowExecutionBackend,
  WorkflowExecutionHandle,
  WorkflowExecutionResult
} from './WorkflowExecutionBackend';
import type {
  AgentRunMetadata,
  AgentRunRecord,
  AgentRunStatus,
  WorkflowRunMetadata
} from './types';
import type {
  ApprovalRequest,
  DurableVaultChangeApplyReceipt,
  VaultChangeApplyReceipt,
  VaultChangeApplyResult,
  VaultOperationApplyReceipt,
  VaultOperationExpectedReadback,
  VaultOperationWriteAhead,
  VaultOperationResult,
  VaultChangeApplier
} from './VaultChangeApplier';

const CLAUDE_MD_INSTRUCTION = 'Read CLAUDE.md before doing anything else and follow every applicable rule.';
const NO_WRITE_CONTRACT = [
  'This is a proposal-only run.',
  'Use only Nexus tools permitted by the vault-readonly capability profile.',
  'Inspect evidence, return exactly one vault-change-plan/v1 JSON document, and perform no mutation.',
  'Do not apply, approve, retry, or bypass a rejected tool call.'
].join(' ');

const ALLOWED_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(['running', 'preflight_failed', 'cancelled', 'interrupted', 'failed']),
  running: new Set([
    'awaiting_approval',
    'preflight_failed',
    'security_blocked',
    'invalid_output',
    'timed_out',
    'cancelled',
    'interrupted',
    'failed'
  ]),
  awaiting_approval: new Set(['applying', 'rejected']),
  applying: new Set(['completed', 'completed_with_issues', 'failed']),
  completed: new Set(),
  completed_with_issues: new Set(),
  rejected: new Set(),
  preflight_failed: new Set(),
  security_blocked: new Set(),
  invalid_output: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
  failed: new Set()
};

export interface AgentRunStartRequest extends WorkflowRunMetadata {
  conversationId: string;
  workspaceId: string;
  workflow: WorkspaceWorkflow;
  execution: WorkflowExecutionConfig;
  resolvedPrompt: string;
  runTrigger: 'manual' | 'scheduled' | 'catch_up';
  scheduledFor: number;
  runKey: string;
  deviceId: string;
}

export interface AgentRunConversationStore {
  getConversation(id: string): Promise<ConversationData | null>;
  listConversationsWithMetadata(): Promise<ConversationData[]>;
  addMessage(params: {
    conversationId: string;
    role: 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  mutateConversationMetadata(
    conversationId: string,
    mutate: (
      current: Readonly<NonNullable<ConversationData['metadata']>>
    ) => NonNullable<ConversationData['metadata']> | null
  ): Promise<{ applied: boolean; metadata?: NonNullable<ConversationData['metadata']> }>;
}

export interface AgentRunServiceDependencies {
  conversations: AgentRunConversationStore;
  backend: WorkflowExecutionBackend;
  applier: Pick<VaultChangeApplier, 'apply' | 'reconcile'>;
  now?: () => number;
  hashSnapshot?: (snapshot: string) => Promise<string>;
}

type AgentRunPatch = Partial<Omit<AgentRunMetadata, 'status'>>;

interface StartEntry {
  cancelRequested: boolean;
  settled: Promise<AgentRunMetadata>;
  resolve(value: AgentRunMetadata): void;
  reject(error: unknown): void;
}

/** Pure lifecycle gate shared by runtime and the later approval stage. */
export function transitionAgentRun(
  current: AgentRunMetadata,
  nextStatus: AgentRunStatus,
  patch: AgentRunPatch
): AgentRunMetadata {
  if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) {
    throw new Error(`Invalid agent run transition: ${current.status} -> ${nextStatus}`);
  }
  return normalizeAgentRunMetadata({
    ...current,
    ...patch,
    status: nextStatus
  });
}

function normalizeAgentRunMetadata(value: AgentRunMetadata): AgentRunMetadata {
  return {
    backend: value.backend,
    authorityScope: value.authorityScope,
    deviceId: value.deviceId,
    status: value.status,
    trigger: value.trigger,
    model: value.model,
    mode: value.mode,
    capabilityProfile: value.capabilityProfile,
    outputSchema: value.outputSchema,
    approvalRequired: value.approvalRequired,
    maxTurns: value.maxTurns,
    timeoutMinutes: value.timeoutMinutes,
    workspaceId: value.workspaceId,
    workflowId: value.workflowId,
    workflowName: value.workflowName,
    promptHash: value.promptHash,
    workflowHash: value.workflowHash,
    queuedAt: value.queuedAt,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.planHash === undefined ? {} : { planHash: value.planHash }),
    ...(value.stdoutTruncated === undefined ? {} : { stdoutTruncated: value.stdoutTruncated }),
    ...(value.stderrTruncated === undefined ? {} : { stderrTruncated: value.stderrTruncated })
  };
}

export class AgentRunService {
  private readonly now: () => number;
  private readonly hashSnapshot: (snapshot: string) => Promise<string>;
  private readonly starts = new Map<string, StartEntry>();
  private readonly handles = new Map<string, WorkflowExecutionHandle>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly applyLocks = new NamedLocks();

  constructor(private readonly dependencies: AgentRunServiceDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.hashSnapshot = dependencies.hashSnapshot ?? hashSnapshot;
  }

  async start(request: AgentRunStartRequest): Promise<AgentRunRecord> {
    if (request.execution.backend !== 'claude-cli') {
      throw new Error('AgentRunService accepts only the claude-cli backend');
    }
    const frozenRequest = this.captureStartRequest(request);
    if (this.starts.has(request.conversationId) || this.handles.has(request.conversationId)) {
      throw new Error(`Agent run is already active: ${request.conversationId}`);
    }

    const entry = createStartEntry();
    this.starts.set(request.conversationId, entry);
    try {
      const record = await this.startReserved(frozenRequest, entry);
      entry.resolve(record);
      return record;
    } catch (error) {
      entry.reject(error);
      throw error;
    } finally {
      this.starts.delete(request.conversationId);
    }
  }

  private async startReserved(request: AgentRunStartRequest, entry: StartEntry): Promise<AgentRunRecord> {
    const conversation = await this.dependencies.conversations.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${request.conversationId}`);
    }
    if (conversation.metadata?.agentRun !== undefined) {
      throw new Error(`Agent run already exists: ${request.conversationId}`);
    }
    const promptHash = await this.hashSnapshot(this.promptSnapshot(request));
    const workflowHash = await this.hashSnapshot(this.workflowSnapshot(request));
    const model = request.execution.model?.trim() || 'sonnet';
    const queued: AgentRunMetadata = {
      backend: 'claude-cli',
      authorityScope: request.execution.authorityScope,
      deviceId: request.deviceId,
      status: 'queued',
      trigger: request.runTrigger === 'manual' ? 'manual' : 'schedule',
      model,
      mode: 'proposal',
      capabilityProfile: request.execution.capabilityProfile,
      outputSchema: request.execution.outputSchema,
      approvalRequired: true,
      maxTurns: request.execution.maxTurns,
      timeoutMinutes: request.execution.timeoutMinutes,
      workspaceId: request.workspaceId,
      workflowId: request.workflow.id,
      workflowName: request.workflow.name,
      promptHash,
      workflowHash,
      queuedAt: this.now()
    };
    const queuedApplied = await this.persistTransition(request.conversationId, [undefined], queued);
    if (!queuedApplied) {
      throw new Error(`Agent run already exists: ${request.conversationId}`);
    }
    if (entry.cancelRequested) {
      return this.record(
        request.conversationId,
        await this.cancelBeforeDispatch(request.conversationId, queued)
      );
    }

    let handle: WorkflowExecutionHandle;
    try {
      handle = this.dependencies.backend.start({
        runId: request.conversationId,
        prompt: this.buildExecutionPrompt(request, promptHash, workflowHash),
        model,
        maxTurns: request.execution.maxTurns,
        timeoutMs: request.execution.timeoutMinutes * 60_000,
        capabilityProfile: request.execution.capabilityProfile
      });
    } catch (error) {
      const failed = transitionAgentRun(queued, 'preflight_failed', {
        finishedAt: this.now()
      });
      await this.appendResultMessage(request.conversationId, this.errorMessage(error), 'preflight_failed');
      const applied = await this.persistTransition(request.conversationId, ['queued'], failed);
      return this.record(request.conversationId, applied ? failed : await this.requireRun(request.conversationId));
    }

    if (handle.runId !== request.conversationId) {
      await this.terminateRetainedHandle(handle);
      const failed = transitionAgentRun(queued, 'failed', { finishedAt: this.now() });
      const applied = await this.persistTransition(request.conversationId, ['queued'], failed);
      return this.record(request.conversationId, applied ? failed : await this.requireRun(request.conversationId));
    }

    this.handles.set(request.conversationId, handle);
    const running = transitionAgentRun(queued, 'running', { startedAt: this.now() });
    try {
      const applied = await this.persistTransition(request.conversationId, ['queued'], running);
      if (!applied) {
        throw new Error(`Agent run queued-to-running transition lost: ${request.conversationId}`);
      }
    } catch (error) {
      await this.terminateRetainedHandle(handle);
      const failed = transitionAgentRun(queued, 'failed', { finishedAt: this.now() });
      try {
        await this.persistTransition(request.conversationId, ['queued', 'running'], failed);
      } catch {
        // The original persistence failure remains authoritative after the
        // backend process is confirmed settled.
      }
      this.handles.delete(request.conversationId);
      throw error;
    }

    const completion = this.completeRun(request.conversationId, handle, {
      runId: request.conversationId,
      workflowId: request.workflow.id,
      promptHash,
      workflowHash,
      workspaceId: request.workspaceId
    }).finally(() => {
      this.handles.delete(request.conversationId);
      this.completions.delete(request.conversationId);
    });
    this.completions.set(request.conversationId, completion);
    void completion.catch(() => undefined);

    if (entry.cancelRequested) {
      await handle.cancel();
      await completion;
      return this.record(request.conversationId, await this.requireRun(request.conversationId));
    }

    return this.record(request.conversationId, running);
  }

  async get(runId: string): Promise<AgentRunRecord | null> {
    const conversation = await this.dependencies.conversations.getConversation(runId);
    return conversation ? this.readRecord(conversation) : null;
  }

  async list(): Promise<AgentRunRecord[]> {
    const conversations = await this.dependencies.conversations.listConversationsWithMetadata();
    return conversations
      .map(conversation => this.readRecord(conversation))
      .filter((run): run is AgentRunRecord => run !== null)
      .sort((left, right) => right.queuedAt - left.queuedAt);
  }

  async approveAndApply(request: ApprovalRequest): Promise<VaultChangeApplyResult> {
    this.assertHumanApproval(request);
    return this.applyLocks.acquire(
      request.runId,
      async () => {
        const conversation = await this.dependencies.conversations.getConversation(request.runId);
        if (!conversation) {
          throw new Error(`Conversation not found: ${request.runId}`);
        }
        const currentValue = conversation.metadata?.agentRun;
        if (!isAgentRunMetadata(currentValue)) {
          throw new Error(`Agent run not found: ${request.runId}`);
        }
        const current = normalizeAgentRunMetadata(currentValue);
        if (current.status !== 'awaiting_approval') {
          throw new Error(`Agent run ${request.runId} is not awaiting approval`);
        }

        const planMessage = this.requirePlanMessage(conversation);
        const plan = parseVaultChangePlan(planMessage.content, {
          runId: request.runId,
          workflowId: current.workflowId,
          promptHash: current.promptHash,
          workflowHash: current.workflowHash,
          workspaceId: current.workspaceId
        });
        const recomputedHash = hashVaultChangePlan(plan);
        const persistedEventHash = this.planMessageHash(planMessage.metadata);
        if (
          current.planHash !== recomputedHash
          || persistedEventHash !== recomputedHash
          || request.planHash !== recomputedHash
        ) {
          throw new Error('Requested plan hash does not match the persisted immutable plan hash');
        }

        const applying = transitionAgentRun(current, 'applying', {});
        const selectedIds = new Set(request.operationIds);
        const selectedOperations = plan.operations
          .filter(operation => selectedIds.has(operation.operationId));
        const initialReceipt: DurableVaultChangeApplyReceipt = {
          schema: 'agent-run-apply-receipt/v2',
          runId: request.runId,
          planHash: request.planHash,
          operationIds: selectedOperations.map(operation => operation.operationId),
          operations: selectedOperations.map(operation => ({
            operationId: operation.operationId,
            type: operation.type,
            dependsOn: [...operation.dependsOn],
            selectedAt: request.approval.confirmedAt,
            state: 'selected'
          }))
        };
        const result = await this.dependencies.applier.apply(plan, request, async () => {
          await this.appendResultMessage(
            request.runId,
            JSON.stringify({
              planHash: request.planHash,
              operationIds: [...request.operationIds],
              approval: {
                kind: request.approval.kind,
                source: request.approval.source,
                confirmedAt: request.approval.confirmedAt
              }
            }),
            'approval'
          );
          const applied = await this.beginApplying(request.runId, current, applying, initialReceipt);
          if (!applied) {
            throw new Error(`Agent run applying transition lost: ${request.runId}`);
          }
        }, async operation => {
          await this.persistOperationReceipt(request.runId, initialReceipt, operation);
        }, async writeAhead => {
          await this.persistOperationWriteAhead(request.runId, initialReceipt, writeAhead);
        });

        await this.appendMissingOperationEvents(request.runId, result);
        return this.reconcileApplyingExclusive(request.runId);
      }
    );
  }

  async reconcileApplying(
    runId: string,
    assertAuthority?: (run: AgentRunRecord) => Promise<void> | void
  ): Promise<VaultChangeApplyResult> {
    return this.applyLocks.acquire(
      runId,
      () => this.reconcileApplyingExclusive(runId, assertAuthority)
    );
  }

  private async reconcileApplyingExclusive(
    runId: string,
    assertAuthority?: (run: AgentRunRecord) => Promise<void> | void
  ): Promise<VaultChangeApplyResult> {
    const conversation = await this.dependencies.conversations.getConversation(runId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${runId}`);
    }
    const currentValue = conversation.metadata?.agentRun;
    if (!isAgentRunMetadata(currentValue)) {
      throw new Error(`Agent run not found: ${runId}`);
    }
    const current = normalizeAgentRunMetadata(currentValue);
    await assertAuthority?.(this.record(runId, current));
    if (current.status !== 'applying'
      && current.status !== 'completed'
      && current.status !== 'completed_with_issues') {
      throw new Error(`Agent run ${runId} is not applying`);
    }

    const planMessage = this.requirePlanMessage(conversation);
    const plan = parseVaultChangePlan(planMessage.content, {
      runId,
      workflowId: current.workflowId,
      promptHash: current.promptHash,
      workflowHash: current.workflowHash,
      workspaceId: current.workspaceId
    });
    const planHash = hashVaultChangePlan(plan);
    if (current.planHash !== planHash || this.planMessageHash(planMessage.metadata) !== planHash) {
      throw new Error('Applying run plan hash does not match the persisted immutable plan hash');
    }
    const receipt = this.requireApplyReceipt(conversation.metadata?.agentRunApplyReceipt);
    if (receipt.runId !== runId || receipt.planHash !== planHash) {
      throw new Error('Apply receipt does not match the applying run');
    }
    if (current.status === 'completed' || current.status === 'completed_with_issues') {
      return this.resultFromReceipt(receipt, current.status);
    }

    const result = await this.dependencies.applier.reconcile(plan, receipt);
    if (receipt.schema === 'agent-run-apply-receipt/v2') {
      for (const operation of result.operations) {
        await this.persistOperationReceipt(runId, receipt, operation);
      }
    }
    await this.appendMissingOperationEvents(runId, result);
    const finalStatus = result.status;
    const completed = transitionAgentRun(current, finalStatus, { finishedAt: this.now() });
    const completedApplied = await this.persistTransition(runId, ['applying'], completed);
    if (!completedApplied) {
      throw new Error(`Agent run completion transition lost: ${runId}`);
    }
    return result;
  }

  private resultFromReceipt(
    receipt: VaultChangeApplyReceipt,
    status: 'completed' | 'completed_with_issues'
  ): VaultChangeApplyResult {
    const operations = receipt.schema === 'agent-run-apply-receipt/v1'
      ? receipt.operations
      : receipt.operations.map(entry => entry.state === 'settled' ? entry.result : null);
    if (receipt.operationIds.length !== operations.length
      || operations.some(operation => operation === null)
      || receipt.operationIds.some((operationId, index) =>
        operationId !== operations[index]?.operationId)) {
      throw new Error('Terminal applying receipt is incomplete or out of order');
    }
    return {
      runId: receipt.runId,
      planHash: receipt.planHash,
      status,
      operations: operations.map(operation => cloneJson(operation!))
    };
  }

  async cancel(runId: string): Promise<AgentRunRecord> {
    const start = this.starts.get(runId);
    if (start) {
      start.cancelRequested = true;
      return this.record(runId, await start.settled);
    }

    const current = await this.requireRun(runId);
    if (current.status === 'awaiting_approval' || current.status === 'applying') {
      return this.applyLocks.acquire(runId, async () => {
        const authoritative = await this.requireRun(runId);
        if (authoritative.status !== 'awaiting_approval') {
          throw new Error(`Agent run ${runId} is not cancellable from ${authoritative.status}`);
        }
        const rejected = transitionAgentRun(authoritative, 'rejected', { finishedAt: this.now() });
        const applied = await this.persistTransition(runId, ['awaiting_approval'], rejected);
        if (!applied) {
          const winner = await this.requireRun(runId);
          throw new Error(`Agent run rejection transition lost from ${winner.status}: ${runId}`);
        }
        return this.record(runId, rejected);
      });
    }
    if (current.status !== 'queued' && current.status !== 'running') {
      throw new Error(`Agent run ${runId} is not cancellable from ${current.status}`);
    }

    const handle = this.handles.get(runId);
    if (!handle) {
      const interrupted = transitionAgentRun(current, 'interrupted', { finishedAt: this.now() });
      const applied = await this.persistTransition(runId, ['queued', 'running'], interrupted);
      return this.record(runId, applied ? interrupted : await this.requireRun(runId));
    }

    await handle.cancel();
    await this.completions.get(runId);
    return this.record(runId, await this.requireRun(runId));
  }

  private async cancelBeforeDispatch(runId: string, queued: AgentRunMetadata): Promise<AgentRunMetadata> {
    const cancelled = transitionAgentRun(queued, 'cancelled', { finishedAt: this.now() });
    const applied = await this.persistTransition(runId, ['queued'], cancelled);
    return applied ? cancelled : await this.requireRun(runId);
  }

  async reconcileInterrupted(): Promise<void> {
    const runs = await this.list();
    for (const run of runs) {
      if (
        (run.status === 'queued' || run.status === 'running')
        && !this.starts.has(run.runId)
        && !this.handles.has(run.runId)
      ) {
        const interrupted = transitionAgentRun(run, 'interrupted', { finishedAt: this.now() });
        await this.persistTransition(run.runId, ['queued', 'running'], interrupted);
      }
    }
  }

  private async completeRun(
    runId: string,
    handle: WorkflowExecutionHandle,
    expectedIdentity: ExpectedPlanIdentity
  ): Promise<void> {
    try {
      const result = await handle.result;
      if (result.runId !== runId) {
        throw new Error(`Workflow backend returned a mismatched runId for ${runId}`);
      }
      await this.persistExecutionResult(runId, result, expectedIdentity);
    } catch (error) {
      const current = await this.requireRun(runId);
      if (current.status !== 'running') {
        return;
      }
      try {
        await this.appendResultMessage(runId, this.errorMessage(error), 'failed');
      } catch {
        // The lifecycle state remains authoritative even when a diagnostic
        // message cannot be appended.
      }
      await this.persistTransition(runId, ['running'], transitionAgentRun(current, 'failed', {
        finishedAt: this.now()
      }));
    }
  }

  private async persistExecutionResult(
    runId: string,
    result: WorkflowExecutionResult,
    expectedIdentity: ExpectedPlanIdentity
  ): Promise<void> {
    const current = await this.requireRun(runId);
    if (current.status !== 'running') {
      return;
    }
    const resultPatch: AgentRunPatch = {
      finishedAt: this.now(),
      durationMs: result.durationMs,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    };

    if (this.isSecurityBlocked(result)) {
      await this.appendExecutionOutput(runId, result, 'security_blocked');
      await this.persistTransition(
        runId,
        ['running'],
        transitionAgentRun(current, 'security_blocked', resultPatch)
      );
      return;
    }

    if (result.status === 'completed') {
      if (result.stdoutTruncated || result.stderrTruncated) {
        await this.appendExecutionOutput(runId, result, 'invalid_output');
        await this.persistTransition(
          runId,
          ['running'],
          transitionAgentRun(current, 'invalid_output', resultPatch)
        );
        return;
      }

      let plan: ReturnType<typeof parseVaultChangePlan>;
      try {
        plan = parseVaultChangePlan(result.stdout, expectedIdentity);
      } catch {
        await this.appendExecutionOutput(runId, result, 'invalid_output');
        await this.persistTransition(
          runId,
          ['running'],
          transitionAgentRun(current, 'invalid_output', resultPatch)
        );
        return;
      }

      const planHash = hashVaultChangePlan(plan);
      await this.appendResultMessage(runId, result.stdout, 'plan', { planHash });
      await this.persistTransition(
        runId,
        ['running'],
        transitionAgentRun(current, 'awaiting_approval', {
          ...resultPatch,
          planHash
        })
      );
      return;
    }

    await this.appendExecutionOutput(runId, result, result.status);
    await this.persistTransition(
      runId,
      ['running'],
      transitionAgentRun(current, result.status, resultPatch)
    );
  }

  private async appendExecutionOutput(
    runId: string,
    result: WorkflowExecutionResult,
    kind: string
  ): Promise<void> {
    if (result.stdout) {
      await this.appendResultMessage(runId, result.stdout, kind, { stream: 'stdout' });
    }
    if (result.stderr) {
      await this.appendResultMessage(runId, result.stderr, kind, { stream: 'stderr' });
    }
  }

  private async beginApplying(
    runId: string,
    expected: AgentRunMetadata,
    applying: AgentRunMetadata,
    receipt: VaultChangeApplyReceipt
  ): Promise<boolean> {
    const result = await this.dependencies.conversations.mutateConversationMetadata(
      runId,
      current => {
        const currentRun = current.agentRun;
        if (!isAgentRunMetadata(currentRun)
          || currentRun.status !== 'awaiting_approval'
          || currentRun.planHash !== expected.planHash
          || current.agentRunApplyReceipt !== undefined) {
          return null;
        }
        return {
          ...current,
          agentRun: normalizeAgentRunMetadata(applying),
          agentRunApplyReceipt: receipt
        };
      }
    );
    return result.applied;
  }

  private async persistOperationReceipt(
    runId: string,
    identity: DurableVaultChangeApplyReceipt,
    operation: VaultOperationResult
  ): Promise<void> {
    const result = await this.dependencies.conversations.mutateConversationMetadata(
      runId,
      current => {
        if (!isAgentRunMetadata(current.agentRun) || current.agentRun.status !== 'applying') {
          return null;
        }
        const receipt = this.requireApplyReceipt(current.agentRunApplyReceipt);
        if (receipt.schema !== 'agent-run-apply-receipt/v2'
          || receipt.runId !== identity.runId
          || receipt.planHash !== identity.planHash
          || !stringArraysEqual(receipt.operationIds, identity.operationIds)) {
          return null;
        }
        const index = receipt.operations.findIndex(item => item.operationId === operation.operationId);
        const existing = receipt.operations[index];
        if (!existing) {
          return null;
        }
        if (existing.state === 'settled') {
          return jsonEqual(existing.result, operation) ? current : null;
        }
        if (existing.type !== operation.type
          || (existing.state === 'selected'
            && operation.status !== 'failed'
            && operation.status !== 'blocked_dependency')) {
          return null;
        }
        const settled: VaultOperationApplyReceipt = {
          operationId: existing.operationId,
          type: existing.type,
          dependsOn: [...existing.dependsOn],
          selectedAt: existing.selectedAt,
          state: 'settled',
          result: cloneJson(operation),
          ...(existing.state === 'pending' ? {
            startedAt: existing.startedAt,
            expectedReadback: cloneJson(existing.expectedReadback)
          } : {})
        };
        return {
          ...current,
          agentRunApplyReceipt: {
            ...receipt,
            operations: receipt.operations.map((entry, entryIndex) =>
              entryIndex === index ? settled : entry)
          }
        };
      }
    );
    if (!result.applied) {
      throw new Error(`Agent run operation receipt persistence lost: ${operation.operationId}`);
    }
  }

  private async persistOperationWriteAhead(
    runId: string,
    identity: DurableVaultChangeApplyReceipt,
    writeAhead: VaultOperationWriteAhead
  ): Promise<void> {
    const result = await this.dependencies.conversations.mutateConversationMetadata(
      runId,
      current => {
        if (!isAgentRunMetadata(current.agentRun) || current.agentRun.status !== 'applying') {
          return null;
        }
        const receipt = this.requireApplyReceipt(current.agentRunApplyReceipt);
        if (receipt.schema !== 'agent-run-apply-receipt/v2'
          || receipt.runId !== identity.runId
          || receipt.planHash !== identity.planHash
          || !stringArraysEqual(receipt.operationIds, identity.operationIds)) {
          return null;
        }
        const index = receipt.operations.findIndex(entry => entry.operationId === writeAhead.operationId);
        const existing = receipt.operations[index];
        if (!existing
          || existing.type !== writeAhead.type
          || !stringArraysEqual(existing.dependsOn, writeAhead.dependsOn)
          || receipt.operations.slice(0, index).some(entry => entry.state !== 'settled')) {
          return null;
        }
        if (existing.state === 'pending') {
          const persisted = {
            operationId: existing.operationId,
            type: existing.type,
            dependsOn: existing.dependsOn,
            startedAt: existing.startedAt,
            expectedReadback: existing.expectedReadback
          };
          return jsonEqual(persisted, writeAhead) ? current : null;
        }
        if (existing.state !== 'selected') {
          return null;
        }
        const pending: VaultOperationApplyReceipt = {
          operationId: existing.operationId,
          type: existing.type,
          dependsOn: [...existing.dependsOn],
          selectedAt: existing.selectedAt,
          state: 'pending',
          startedAt: writeAhead.startedAt,
          expectedReadback: cloneJson(writeAhead.expectedReadback)
        };
        return {
          ...current,
          agentRunApplyReceipt: {
            ...receipt,
            operations: receipt.operations.map((entry, entryIndex) =>
              entryIndex === index ? pending : entry)
          }
        };
      }
    );
    if (!result.applied) {
      throw new Error(`Agent run operation write-ahead persistence lost: ${writeAhead.operationId}`);
    }
  }

  private async appendMissingOperationEvents(
    runId: string,
    result: VaultChangeApplyResult
  ): Promise<void> {
    const conversation = await this.dependencies.conversations.getConversation(runId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${runId}`);
    }
    for (const operation of result.operations) {
      const matchingEvents = conversation.messages.filter(message => {
        const event = isRecord(message.metadata?.agentRunEvent)
          ? message.metadata.agentRunEvent
          : undefined;
        return event?.kind === 'operation_result' && event.operationId === operation.operationId;
      });
      if (matchingEvents.length > 1) {
        throw new Error(`Duplicate operation result events for ${operation.operationId}`);
      }
      if (matchingEvents.length === 1) {
        const event = matchingEvents[0].metadata?.agentRunEvent;
        if (!isRecord(event)
          || event.planHash !== result.planHash
          || matchingEvents[0].content !== JSON.stringify(operation)) {
          throw new Error(`Operation result event conflicts with receipt: ${operation.operationId}`);
        }
        continue;
      }
      await this.appendResultMessage(
        runId,
        JSON.stringify(operation),
        'operation_result',
        { operationId: operation.operationId, planHash: result.planHash }
      );
    }
  }

  private requireApplyReceipt(value: unknown): VaultChangeApplyReceipt {
    if (!isRecord(value)
      || (value.schema !== 'agent-run-apply-receipt/v1'
        && value.schema !== 'agent-run-apply-receipt/v2')
      || typeof value.runId !== 'string'
      || typeof value.planHash !== 'string'
      || !Array.isArray(value.operationIds)
      || value.operationIds.some(operationId => typeof operationId !== 'string')
      || !Array.isArray(value.operations)) {
      throw new Error('Applying run lacks a valid durable receipt');
    }
    if (value.schema === 'agent-run-apply-receipt/v2') {
      assertOnlyKeys(value, ['schema', 'runId', 'planHash', 'operationIds', 'operations']);
      return {
        schema: 'agent-run-apply-receipt/v2',
        runId: value.runId,
        planHash: value.planHash,
        operationIds: value.operationIds.map(operationId => String(operationId)),
        operations: value.operations.map(operation => this.requireOperationApplyReceipt(operation))
      };
    }
    const operations = value.operations.map(operation => this.requireOperationResult(operation, false));
    return {
      schema: 'agent-run-apply-receipt/v1',
      runId: value.runId,
      planHash: value.planHash,
      operationIds: value.operationIds.map(operationId => String(operationId)),
      operations
    };
  }

  private requireOperationApplyReceipt(value: unknown): VaultOperationApplyReceipt {
    if (!isRecord(value)
      || typeof value.operationId !== 'string'
      || !isVaultOperationType(value.type)
      || !Array.isArray(value.dependsOn)
      || value.dependsOn.some(dependency => typeof dependency !== 'string')
      || typeof value.selectedAt !== 'number'
      || !Number.isFinite(value.selectedAt)) {
      throw new Error('Applying run contains an invalid operation write-ahead receipt');
    }
    const base = {
      operationId: value.operationId,
      type: value.type,
      dependsOn: value.dependsOn.map(String),
      selectedAt: value.selectedAt
    };
    if (value.state === 'selected') {
      assertOnlyKeys(value, ['operationId', 'type', 'dependsOn', 'selectedAt', 'state']);
      return { ...base, state: 'selected' };
    }
    if (value.state === 'pending') {
      assertOnlyKeys(value, [
        'operationId', 'type', 'dependsOn', 'selectedAt', 'state', 'startedAt', 'expectedReadback'
      ]);
      if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) {
        throw new Error('Applying run contains an invalid pending operation time');
      }
      return {
        ...base,
        state: 'pending',
        startedAt: value.startedAt,
        expectedReadback: this.requireExpectedReadback(value.expectedReadback)
      };
    }
    if (value.state === 'settled') {
      assertOnlyKeys(value, [
        'operationId', 'type', 'dependsOn', 'selectedAt', 'state', 'result',
        'startedAt', 'expectedReadback'
      ]);
      const result = this.requireOperationResult(value.result, true);
      const hasWriteAhead = value.startedAt !== undefined || value.expectedReadback !== undefined;
      if (hasWriteAhead
        && (typeof value.startedAt !== 'number'
          || !Number.isFinite(value.startedAt)
          || value.expectedReadback === undefined)) {
        throw new Error('Applying run contains an incomplete settled write-ahead receipt');
      }
      return {
        ...base,
        state: 'settled',
        result,
        ...(hasWriteAhead ? {
          startedAt: value.startedAt as number,
          expectedReadback: this.requireExpectedReadback(value.expectedReadback)
        } : {})
      };
    }
    throw new Error('Applying run contains an invalid operation receipt state');
  }

  private requireExpectedReadback(value: unknown): VaultOperationExpectedReadback {
    if (!isRecord(value) || typeof value.kind !== 'string') {
      throw new Error('Applying run contains an invalid expected readback descriptor');
    }
    if (value.kind === 'rename') {
      assertOnlyKeys(value, ['kind', 'sourcePath', 'destinationPath']);
      if (typeof value.sourcePath !== 'string' || typeof value.destinationPath !== 'string') {
        throw new Error('Applying run contains an invalid rename descriptor');
      }
      return {
        kind: 'rename',
        sourcePath: value.sourcePath,
        destinationPath: value.destinationPath
      };
    }
    if (value.kind === 'setProperty') {
      assertOnlyKeys(value, ['kind', 'path', 'property', 'value']);
      if (typeof value.path !== 'string' || typeof value.property !== 'string') {
        throw new Error('Applying run contains an invalid property descriptor');
      }
      return {
        kind: 'setProperty',
        path: value.path,
        property: value.property,
        value: cloneJson(value.value)
      };
    }
    if (value.kind === 'contentHash') {
      assertOnlyKeys(value, ['kind', 'path', 'contentHash']);
      if (typeof value.path !== 'string' || typeof value.contentHash !== 'string') {
        throw new Error('Applying run contains an invalid content descriptor');
      }
      return { kind: 'contentHash', path: value.path, contentHash: value.contentHash };
    }
    throw new Error('Applying run contains an unknown expected readback descriptor');
  }

  private requireOperationResult(value: unknown, closed = false): VaultOperationResult {
    if (!isRecord(value)
      || typeof value.operationId !== 'string'
      || !isVaultOperationType(value.type)
      || !isVaultOperationStatus(value.status)
      || typeof value.startedAt !== 'number'
      || !Number.isFinite(value.startedAt)
      || typeof value.finishedAt !== 'number'
      || !Number.isFinite(value.finishedAt)
      || (value.readback !== undefined && !isRecord(value.readback))
      || (value.error !== undefined && typeof value.error !== 'string')
      || (value.rollbackError !== undefined && typeof value.rollbackError !== 'string')) {
      throw new Error('Applying run contains an invalid operation receipt');
    }
    if (closed) {
      assertOnlyKeys(value, [
        'operationId', 'type', 'status', 'startedAt', 'finishedAt',
        'readback', 'error', 'rollbackError'
      ]);
    }
    return {
      operationId: value.operationId,
      type: value.type,
      status: value.status,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      ...(value.readback === undefined ? {} : { readback: value.readback }),
      ...(value.error === undefined ? {} : { error: value.error }),
      ...(value.rollbackError === undefined ? {} : { rollbackError: value.rollbackError })
    };
  }

  private async appendResultMessage(
    runId: string,
    content: string,
    kind: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!content) {
      return;
    }
    const result = await this.dependencies.conversations.addMessage({
      conversationId: runId,
      role: 'assistant',
      content,
      metadata: {
        agentRunEvent: {
          kind,
          ...metadata
        }
      }
    });
    this.assertSuccessfulStoreResult(result, 'append agent run message');
  }

  private assertHumanApproval(request: ApprovalRequest): void {
    if (!request || typeof request !== 'object'
      || !request.approval
      || request.approval.kind !== 'human'
      || (request.approval.source !== 'nexus-ui' && request.approval.source !== 'thinkbox')
      || !Number.isFinite(request.approval.confirmedAt)) {
      throw new Error('explicit human approval context is required');
    }
  }

  private requirePlanMessage(conversation: ConversationData): ConversationData['messages'][number] {
    const plans = conversation.messages.filter(message => {
      const event = isRecord(message.metadata?.agentRunEvent)
        ? message.metadata?.agentRunEvent
        : undefined;
      return message.role === 'assistant' && event?.kind === 'plan';
    });
    if (plans.length !== 1) {
      throw new Error(`Agent run ${conversation.id} must contain exactly one immutable plan message`);
    }
    return plans[0];
  }

  private planMessageHash(metadata: Record<string, unknown> | undefined): string | undefined {
    const event = metadata && isRecord(metadata.agentRunEvent)
      ? metadata.agentRunEvent
      : undefined;
    return typeof event?.planHash === 'string' ? event.planHash : undefined;
  }

  private async persistTransition(
    runId: string,
    expectedStatuses: readonly (AgentRunStatus | undefined)[],
    next: AgentRunMetadata
  ): Promise<boolean> {
    const result = await this.dependencies.conversations.mutateConversationMetadata(
      runId,
      current => {
        const currentRun = current.agentRun;
        if (currentRun !== undefined && !isAgentRunMetadata(currentRun)) {
          return null;
        }
        const currentStatus = isAgentRunMetadata(currentRun) ? currentRun.status : undefined;
        if (!expectedStatuses.includes(currentStatus)) {
          return null;
        }
        return {
          ...current,
          agentRun: normalizeAgentRunMetadata(next)
        };
      }
    );
    return result.applied;
  }

  private readRecord(conversation: ConversationData): AgentRunRecord | null {
    const value = conversation.metadata?.agentRun;
    if (!isAgentRunMetadata(value)) {
      return null;
    }
    return this.record(conversation.id, normalizeAgentRunMetadata(value));
  }

  private record(runId: string, metadata: AgentRunMetadata): AgentRunRecord {
    return {
      runId,
      conversationId: runId,
      ...metadata
    };
  }

  private async requireRun(runId: string): Promise<AgentRunMetadata> {
    const conversation = await this.dependencies.conversations.getConversation(runId);
    const agentRun = conversation?.metadata?.agentRun;
    if (!isAgentRunMetadata(agentRun)) {
      throw new Error(`Agent run not found: ${runId}`);
    }
    return normalizeAgentRunMetadata(agentRun);
  }

  private promptSnapshot(request: AgentRunStartRequest): string {
    return JSON.stringify([
      'agent-run-prompt-snapshot/v1',
      CLAUDE_MD_INSTRUCTION,
      request.workspaceId,
      request.resolvedPrompt
    ]);
  }

  private captureStartRequest(request: AgentRunStartRequest): AgentRunStartRequest {
    return {
      ...request,
      workflow: {
        ...request.workflow,
        execution: request.workflow.execution
          ? { ...request.workflow.execution }
          : undefined,
        schedule: request.workflow.schedule
          ? { ...request.workflow.schedule }
          : undefined
      },
      execution: { ...request.execution }
    };
  }

  private workflowSnapshot(request: AgentRunStartRequest): string {
    return JSON.stringify([
      'agent-run-workflow-snapshot/v1',
      request.workspaceId,
      request.workflow.id,
      request.workflow.name,
      request.workflow.when,
      request.workflow.steps,
      request.workflow.promptId ?? null,
      request.execution.backend,
      request.execution.authorityScope,
      request.deviceId,
      request.execution.model?.trim() || 'sonnet',
      request.execution.mode,
      request.execution.capabilityProfile,
      request.execution.outputSchema,
      request.execution.maxTurns,
      request.execution.timeoutMinutes,
      request.execution.approvalRequired,
      request.runTrigger,
      request.scheduledFor,
      request.runKey
    ]);
  }

  private buildExecutionPrompt(
    request: AgentRunStartRequest,
    promptHash: string,
    workflowHash: string
  ): string {
    return [
      '# Supervised Nexus workflow proposal',
      '',
      '## Mandatory bootstrap',
      CLAUDE_MD_INSTRUCTION,
      '',
      '## Resolved workspace and saved-prompt instructions',
      request.resolvedPrompt,
      '',
      '## Workflow',
      `Name: ${request.workflow.name}`,
      `When: ${request.workflow.when}`,
      'Steps:',
      request.workflow.steps,
      '',
      '## Required output identity',
      `schema: ${request.execution.outputSchema}`,
      `runId: ${request.conversationId}`,
      `workflowId: ${request.workflow.id}`,
      `workspaceId: ${request.workspaceId}`,
      `promptHash: ${promptHash}`,
      `workflowHash: ${workflowHash}`,
      '',
      '## No-write contract',
      NO_WRITE_CONTRACT
    ].join('\n');
  }

  private isSecurityBlocked(result: WorkflowExecutionResult): boolean {
    return result.securityBlocked;
  }

  private async terminateRetainedHandle(handle: WorkflowExecutionHandle): Promise<void> {
    try {
      await handle.cancel();
    } catch {
      // Settlement below remains mandatory even if cancellation reports an error.
    }
    try {
      await handle.result;
    } catch {
      // A rejected result is still a settled, non-orphaned handle.
    }
  }

  private assertSuccessfulStoreResult(result: unknown, action: string): void {
    if (isRecord(result) && result.success === false) {
      const detail = typeof result.error === 'string'
        ? result.error
        : 'unknown storage error';
      throw new Error(`${action} failed: ${detail}`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function createStartEntry(): StartEntry {
  let resolve!: (value: AgentRunMetadata) => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<AgentRunMetadata>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void settled.catch(() => undefined);
  return {
    cancelRequested: false,
    settled,
    resolve,
    reject
  };
}

async function hashSnapshot(snapshot: string): Promise<string> {
  if (!window.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable for agent run snapshots');
  }
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  const hex = Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function isAgentRunMetadata(value: unknown): value is AgentRunMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return value.backend === 'claude-cli'
    && (value.authorityScope === 'vault-synced' || value.authorityScope === 'machine-local')
    && typeof value.deviceId === 'string'
    && typeof value.status === 'string'
    && Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, value.status)
    && (value.trigger === 'manual' || value.trigger === 'schedule')
    && typeof value.model === 'string'
    && value.mode === 'proposal'
    && value.capabilityProfile === 'vault-readonly'
    && value.outputSchema === 'vault-change-plan/v1'
    && value.approvalRequired === true
    && typeof value.maxTurns === 'number'
    && typeof value.timeoutMinutes === 'number'
    && typeof value.workspaceId === 'string'
    && typeof value.workflowId === 'string'
    && typeof value.workflowName === 'string'
    && typeof value.promptHash === 'string'
    && typeof value.workflowHash === 'string'
    && typeof value.queuedAt === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(`Applying run receipt contains unknown field: ${unknown}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isVaultOperationType(value: unknown): value is VaultOperationResult['type'] {
  return value === 'move'
    || value === 'archive'
    || value === 'setProperty'
    || value === 'replaceAnchored';
}

function isVaultOperationStatus(value: unknown): value is VaultOperationResult['status'] {
  return value === 'succeeded'
    || value === 'failed'
    || value === 'blocked_dependency'
    || value === 'readback_failed'
    || value === 'rolled_back'
    || value === 'rollback_failed';
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
