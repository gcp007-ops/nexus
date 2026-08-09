import type {
  WorkflowExecutionConfig,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';
import type { ConversationData } from '../../types/chat/ChatTypes';
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

const CLAUDE_MD_INSTRUCTION = 'Read CLAUDE.md before doing anything else and follow every applicable rule.';
const NO_WRITE_CONTRACT = [
  'This is a proposal-only run.',
  'Use only Nexus tools permitted by the vault-readonly capability profile.',
  'Inspect evidence, return exactly one vault-change-plan/v1 JSON document, and perform no mutation.',
  'Do not apply, approve, retry, or bypass a rejected tool call.'
].join(' ');
const CAPABILITY_REJECTION = /not allowed by capability profile vault-readonly/iu;

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
  updateConversationMetadata(
    conversationId: string,
    metadata: NonNullable<ConversationData['metadata']>
  ): Promise<unknown>;
}

export interface AgentRunServiceDependencies {
  conversations: AgentRunConversationStore;
  backend: WorkflowExecutionBackend;
  now?: () => number;
  hashSnapshot?: (snapshot: string) => Promise<string>;
}

type AgentRunPatch = Partial<Omit<AgentRunMetadata, 'status'>>;

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
  private readonly starting = new Set<string>();
  private readonly queuedCancellations = new Map<string, Promise<AgentRunMetadata>>();
  private readonly handles = new Map<string, WorkflowExecutionHandle>();
  private readonly completions = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: AgentRunServiceDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.hashSnapshot = dependencies.hashSnapshot ?? hashSnapshot;
  }

  async start(request: AgentRunStartRequest): Promise<AgentRunRecord> {
    if (request.execution.backend !== 'claude-cli') {
      throw new Error('AgentRunService accepts only the claude-cli backend');
    }
    const frozenRequest = this.captureStartRequest(request);
    if (this.starting.has(request.conversationId) || this.handles.has(request.conversationId)) {
      throw new Error(`Agent run is already active: ${request.conversationId}`);
    }

    this.starting.add(request.conversationId);
    try {
      return await this.startReserved(frozenRequest);
    } finally {
      this.starting.delete(request.conversationId);
      this.queuedCancellations.delete(request.conversationId);
    }
  }

  private async startReserved(request: AgentRunStartRequest): Promise<AgentRunRecord> {
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
    await this.persistAgentRun(request.conversationId, queued);
    const queuedCancellation = this.queuedCancellations.get(request.conversationId);
    if (queuedCancellation) {
      return this.record(request.conversationId, await queuedCancellation);
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
      await this.persistAgentRun(request.conversationId, failed);
      return this.record(request.conversationId, failed);
    }

    if (handle.runId !== request.conversationId) {
      this.cancelDetached(handle);
      const failed = transitionAgentRun(queued, 'failed', { finishedAt: this.now() });
      await this.persistAgentRun(request.conversationId, failed);
      return this.record(request.conversationId, failed);
    }

    this.handles.set(request.conversationId, handle);
    const running = transitionAgentRun(queued, 'running', { startedAt: this.now() });
    try {
      await this.persistAgentRun(request.conversationId, running);
    } catch (error) {
      this.cancelDetached(handle);
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

  async cancel(runId: string): Promise<AgentRunRecord> {
    if (this.starting.has(runId) && !this.handles.has(runId)) {
      let cancellation = this.queuedCancellations.get(runId);
      if (!cancellation) {
        cancellation = this.cancelQueuedStart(runId);
        this.queuedCancellations.set(runId, cancellation);
      }
      return this.record(runId, await cancellation);
    }

    const current = await this.requireRun(runId);
    if (current.status !== 'queued' && current.status !== 'running') {
      throw new Error(`Agent run ${runId} is not cancellable from ${current.status}`);
    }

    const handle = this.handles.get(runId);
    if (!handle) {
      const interrupted = transitionAgentRun(current, 'interrupted', { finishedAt: this.now() });
      await this.persistAgentRun(runId, interrupted);
      return this.record(runId, interrupted);
    }

    await handle.cancel();
    await this.completions.get(runId);
    return this.record(runId, await this.requireRun(runId));
  }

  private async cancelQueuedStart(runId: string): Promise<AgentRunMetadata> {
    const current = await this.requireRun(runId);
    if (current.status !== 'queued') {
      throw new Error(`Agent run ${runId} is not cancellable before dispatch from ${current.status}`);
    }
    const cancelled = transitionAgentRun(current, 'cancelled', { finishedAt: this.now() });
    await this.persistAgentRun(runId, cancelled);
    return cancelled;
  }

  async reconcileInterrupted(): Promise<void> {
    const runs = await this.list();
    for (const run of runs) {
      if (
        (run.status === 'queued' || run.status === 'running')
        && !this.starting.has(run.runId)
        && !this.handles.has(run.runId)
      ) {
        const interrupted = transitionAgentRun(run, 'interrupted', { finishedAt: this.now() });
        await this.persistAgentRun(run.runId, interrupted);
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
      await this.persistAgentRun(runId, transitionAgentRun(current, 'failed', {
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
      await this.persistAgentRun(runId, transitionAgentRun(current, 'security_blocked', resultPatch));
      return;
    }

    if (result.status === 'completed') {
      let plan: ReturnType<typeof parseVaultChangePlan>;
      try {
        plan = parseVaultChangePlan(result.stdout, expectedIdentity);
      } catch {
        await this.appendExecutionOutput(runId, result, 'invalid_output');
        await this.persistAgentRun(runId, transitionAgentRun(current, 'invalid_output', resultPatch));
        return;
      }

      const planHash = hashVaultChangePlan(plan);
      await this.appendResultMessage(runId, result.stdout, 'plan', { planHash });
      await this.persistAgentRun(runId, transitionAgentRun(current, 'awaiting_approval', {
        ...resultPatch,
        planHash
      }));
      return;
    }

    await this.appendExecutionOutput(runId, result, result.status);
    await this.persistAgentRun(runId, transitionAgentRun(current, result.status, resultPatch));
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

  private async persistAgentRun(runId: string, agentRun: AgentRunMetadata): Promise<void> {
    const result = await this.dependencies.conversations.updateConversationMetadata(runId, {
      agentRun
    });
    this.assertSuccessfulStoreResult(result, 'update agent run metadata');
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
    return CAPABILITY_REJECTION.test(`${result.stdout}\n${result.stderr}`);
  }

  private cancelDetached(handle: WorkflowExecutionHandle): void {
    void handle.cancel().catch(() => undefined);
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
