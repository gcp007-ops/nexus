import type { ConversationService } from '../ConversationService';
import type { WorkspaceService } from '../WorkspaceService';
import type { ClaudeHeadlessPreflightResult } from '../external/ClaudeHeadlessService';
import type { WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import type {
  IndividualConversation,
  ConversationMessage
} from '../../types/storage/StorageTypes';
import type { AgentRunService } from './AgentRunService';
import type { WorkflowAuthorityService } from './WorkflowAuthorityService';
import type { WorkflowRunService } from './WorkflowRunService';
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunTrigger
} from './types';
import {
  parseVaultChangePlan,
  type VaultChangePlan
} from './VaultChangePlan';
import type {
  ApprovalRequest,
  VaultOperationResult
} from './VaultChangeApplier';

export interface SupervisedWorkflowSummary {
  workspaceId: string;
  workspaceName: string;
  workflowId: string;
  workflowName: string;
  when: string;
  prompt: { id?: string; name?: string };
  model: string;
  scheduleEnabled: boolean;
}

export interface SupervisedPreflight {
  workflowId: string;
  ready: boolean;
  checks: {
    desktop: boolean;
    claudeAvailable: boolean;
    nodeAvailable: boolean;
    connectorAvailable: boolean;
    vaultAvailable: boolean;
    authenticated: boolean;
    authority: boolean;
  };
  issues: string[];
}

export interface SupervisedRunTraceEvent {
  kind: string;
  timestamp: number;
  stream?: 'stdout' | 'stderr';
  operationId?: string;
}

export interface SupervisedRun {
  runId: string;
  workspace: { id: string; name?: string };
  workflow: { id: string; name: string };
  prompt: { id?: string; name?: string };
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  model: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  hashes: {
    promptHash: string;
    workflowHash: string;
    planHash?: string;
  };
  planValidation: {
    status: 'not_available' | 'valid' | 'rejected';
    message?: string;
  };
  plan: VaultChangePlan | null;
  stdout: string[];
  stderr: string[];
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  approval: {
    source: 'nexus-ui' | 'thinkbox';
    confirmedAt: number;
    operationIds: string[];
  } | null;
  application: {
    operationIds: string[];
    operations: VaultOperationResult[];
  } | null;
  trace: SupervisedRunTraceEvent[];
}

export interface SupervisedWorkflowServiceDependencies {
  workspaceService: Pick<WorkspaceService, 'getAllWorkspaces' | 'getWorkspace'>;
  workflowRunService: Pick<WorkflowRunService, 'start'>;
  agentRunService: Pick<AgentRunService, 'get' | 'list' | 'cancel' | 'approveAndApply'>;
  conversationService: Pick<ConversationService, 'getConversation'>;
  authorityService: Pick<WorkflowAuthorityService, 'assertCanRun'>;
  getBackendPreflight(): Promise<ClaudeHeadlessPreflightResult>;
  isDesktop(): boolean;
  openRun(runId: string): Promise<void>;
  openWorkflow(workspaceId: string, workflowId: string): Promise<void>;
}

const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  'queued',
  'running',
  'awaiting_approval',
  'applying'
]);

export class SupervisedWorkflowService {
  constructor(private readonly dependencies: SupervisedWorkflowServiceDependencies) {}

  async listWorkflows(): Promise<SupervisedWorkflowSummary[]> {
    const workspaces = await this.dependencies.workspaceService.getAllWorkspaces();
    return workspaces.flatMap(workspace => (workspace.context?.workflows ?? [])
      .filter(isCompatibleWorkflow)
      .map(workflow => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workflowId: workflow.id,
        workflowName: workflow.name,
        when: workflow.when,
        prompt: {
          ...(workflow.promptId ? { id: workflow.promptId } : {}),
          ...(workflow.promptName ? { name: workflow.promptName } : {})
        },
        model: workflow.execution?.model?.trim() || 'sonnet',
        scheduleEnabled: workflow.schedule?.enabled === true
      })));
  }

  async getPreflight(workflowId: string): Promise<SupervisedPreflight> {
    const { workflow } = await this.findUniqueWorkflow(workflowId);
    this.assertCompatible(workflow);

    const backend = await this.dependencies.getBackendPreflight();
    const issues: string[] = [];
    const desktop = this.dependencies.isDesktop();
    let authority = true;
    try {
      this.dependencies.authorityService.assertCanRun(workflow.execution!);
    } catch (error) {
      authority = false;
      issues.push(errorMessage(error));
    }

    const checks = {
      desktop,
      claudeAvailable: backend.claudePath !== null,
      nodeAvailable: backend.nodePath !== null,
      connectorAvailable: backend.connectorPath !== null,
      vaultAvailable: backend.vaultPath !== null,
      authenticated: backend.isAuthenticated,
      authority
    };
    if (!checks.desktop) issues.push('Supervised Claude workflows require desktop Nexus.');
    if (!checks.claudeAvailable) issues.push('Claude Code is unavailable.');
    if (!checks.nodeAvailable) issues.push('Node.js is unavailable.');
    if (!checks.connectorAvailable) issues.push('The Nexus connector is unavailable.');
    if (!checks.vaultAvailable) issues.push('The vault filesystem is unavailable.');
    if (!checks.authenticated) issues.push('Claude Code is not authenticated.');

    return {
      workflowId,
      ready: Object.values(checks).every(Boolean),
      checks,
      issues
    };
  }

  async start(input: { workspaceId: string; workflowId: string }): Promise<{ runId: string }> {
    const workspace = await this.dependencies.workspaceService.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }
    const workflow = workspace.context?.workflows?.find(item => item.id === input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${input.workflowId}`);
    }
    this.assertCompatible(workflow);

    const result = await this.dependencies.workflowRunService.start({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      openInChat: false
    });
    if (!result.runId) {
      throw new Error(`Supervised workflow did not return a runId: ${input.workflowId}`);
    }
    return { runId: result.runId };
  }

  async getRun(runId: string): Promise<SupervisedRun> {
    const record = await this.dependencies.agentRunService.get(runId);
    if (!record) {
      throw new Error(`Agent run not found: ${runId}`);
    }
    return this.toRunDto(record);
  }

  async listRuns(filter?: { workflowId?: string; activeOnly?: boolean }): Promise<SupervisedRun[]> {
    const records = await this.dependencies.agentRunService.list();
    const selected = records.filter(record =>
      (!filter?.workflowId || record.workflowId === filter.workflowId)
      && (!filter?.activeOnly || ACTIVE_STATUSES.has(record.status))
    );
    return Promise.all(selected.map(record => this.toRunDto(record)));
  }

  async cancel(runId: string): Promise<SupervisedRun> {
    await this.dependencies.agentRunService.cancel(runId);
    return this.getRun(runId);
  }

  async approveAndApply(input: ApprovalRequest): Promise<SupervisedRun> {
    await this.dependencies.agentRunService.approveAndApply(input);
    return this.getRun(input.runId);
  }

  async openRun(runId: string): Promise<void> {
    await this.dependencies.openRun(runId);
  }

  async openWorkflow(workspaceId: string, workflowId: string): Promise<void> {
    const workspace = await this.dependencies.workspaceService.getWorkspace(workspaceId);
    const workflow = workspace?.context?.workflows?.find(item => item.id === workflowId);
    if (!workspace || !workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    this.assertCompatible(workflow);
    await this.dependencies.openWorkflow(workspaceId, workflowId);
  }

  private async findUniqueWorkflow(workflowId: string): Promise<{
    workflow: WorkspaceWorkflow;
  }> {
    const workspaces = await this.dependencies.workspaceService.getAllWorkspaces();
    const matches = workspaces.flatMap(workspace => (workspace.context?.workflows ?? [])
      .filter(workflow => workflow.id === workflowId)
      .map(workflow => ({ workflow })));
    if (matches.length === 0) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (matches.length > 1) {
      throw new Error(`Workflow id is ambiguous across workspaces: ${workflowId}`);
    }
    return matches[0];
  }

  private assertCompatible(workflow: WorkspaceWorkflow): void {
    if (!isCompatibleWorkflow(workflow)) {
      throw new Error(`Workflow is not a compatible supervised Claude workflow: ${workflow.id}`);
    }
  }

  private async toRunDto(record: AgentRunRecord): Promise<SupervisedRun> {
    const storedConversation = await this.dependencies.conversationService.getConversation(record.runId);
    if (!storedConversation) {
      throw new Error(`Conversation not found: ${record.runId}`);
    }
    const conversation = toRunConversation(storedConversation);
    const workspace = await this.dependencies.workspaceService.getWorkspace(record.workspaceId);
    const workflow = workspace?.context?.workflows?.find(item => item.id === record.workflowId);
    const planResult = readPlan(conversation, record);
    const approval = readApproval(conversation);
    const application = readApplication(conversation);
    const streams = readStreams(conversation);

    return {
      runId: record.runId,
      workspace: {
        id: record.workspaceId,
        ...(workspace?.name ? { name: workspace.name } : {})
      },
      workflow: { id: record.workflowId, name: record.workflowName },
      prompt: {
        ...(workflow?.promptId ? { id: workflow.promptId } : {}),
        ...(workflow?.promptName ? { name: workflow.promptName } : {})
      },
      status: record.status,
      trigger: record.trigger,
      model: record.model,
      queuedAt: record.queuedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      hashes: {
        promptHash: record.promptHash,
        workflowHash: record.workflowHash,
        ...(record.planHash ? { planHash: record.planHash } : {})
      },
      planValidation: planResult.validation,
      plan: planResult.plan,
      stdout: streams.stdout,
      stderr: streams.stderr,
      stdoutTruncated: record.stdoutTruncated === true,
      stderrTruncated: record.stderrTruncated === true,
      approval,
      application,
      trace: readTrace(conversation)
    };
  }
}

function isCompatibleWorkflow(workflow: WorkspaceWorkflow): boolean {
  return workflow.execution?.backend === 'claude-cli'
    && workflow.execution.mode === 'proposal'
    && workflow.execution.capabilityProfile === 'vault-readonly'
    && workflow.execution.outputSchema === 'vault-change-plan/v1'
    && workflow.execution.approvalRequired === true;
}

function readPlan(
  conversation: RunConversation,
  record: AgentRunRecord
): {
  validation: SupervisedRun['planValidation'];
  plan: VaultChangePlan | null;
} {
  const messages = conversation.messages.filter(message => eventKind(message.metadata) === 'plan');
  if (messages.length === 0) {
    return {
      validation: record.status === 'invalid_output'
        ? { status: 'rejected', message: 'Output did not match vault-change-plan/v1.' }
        : { status: 'not_available' },
      plan: null
    };
  }
  if (messages.length !== 1) {
    return {
      validation: { status: 'rejected', message: 'The run contains multiple plan records.' },
      plan: null
    };
  }
  try {
    const plan = parseVaultChangePlan(messages[0].content, {
      runId: record.runId,
      workflowId: record.workflowId,
      promptHash: record.promptHash,
      workflowHash: record.workflowHash,
      workspaceId: record.workspaceId
    });
    const persistedHash = eventRecord(messages[0].metadata)?.planHash;
    if (typeof persistedHash !== 'string' || persistedHash !== record.planHash) {
      throw new Error('Persisted plan identity does not match the run.');
    }
    return { validation: { status: 'valid' }, plan: cloneJson(plan) };
  } catch (error) {
    return {
      validation: { status: 'rejected', message: errorMessage(error) },
      plan: null
    };
  }
}

function readStreams(conversation: RunConversation): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const message of conversation.messages) {
    const event = eventRecord(message.metadata);
    if (event?.stream === 'stdout') stdout.push(message.content);
    if (event?.stream === 'stderr') stderr.push(message.content);
  }
  return { stdout, stderr };
}

function readApproval(conversation: RunConversation): SupervisedRun['approval'] {
  const message = conversation.messages.find(item => eventKind(item.metadata) === 'approval');
  if (!message) return null;
  const parsed = parseRecord(message.content);
  const approval = isRecord(parsed?.approval) ? parsed.approval : null;
  if (!approval
    || (approval.source !== 'nexus-ui' && approval.source !== 'thinkbox')
    || typeof approval.confirmedAt !== 'number'
    || !Array.isArray(parsed?.operationIds)
    || parsed.operationIds.some(item => typeof item !== 'string')) {
    return null;
  }
  return {
    source: approval.source,
    confirmedAt: approval.confirmedAt,
    operationIds: parsed.operationIds.map(String)
  };
}

function readApplication(conversation: RunConversation): SupervisedRun['application'] {
  const value = conversation.metadata?.agentRunApplyReceipt;
  if (!isRecord(value)
    || value.schema !== 'agent-run-apply-receipt/v1'
    || !Array.isArray(value.operationIds)
    || value.operationIds.some(item => typeof item !== 'string')
    || !Array.isArray(value.operations)) {
    return null;
  }
  const operations = value.operations.map(projectOperationResult);
  if (operations.some(operation => operation === null)) return null;
  return {
    operationIds: value.operationIds.map(String),
    operations: operations.filter((operation): operation is VaultOperationResult => operation !== null)
  };
}

function readTrace(conversation: RunConversation): SupervisedRunTraceEvent[] {
  return conversation.messages.flatMap(message => {
    const event = eventRecord(message.metadata);
    if (!event || typeof event.kind !== 'string') return [];
    return [{
      kind: event.kind,
      timestamp: message.timestamp,
      ...(event.stream === 'stdout' || event.stream === 'stderr' ? { stream: event.stream } : {}),
      ...(typeof event.operationId === 'string' ? { operationId: event.operationId } : {})
    }];
  });
}

function eventKind(metadata: Record<string, unknown> | undefined): string | undefined {
  const event = eventRecord(metadata);
  return typeof event?.kind === 'string' ? event.kind : undefined;
}

function eventRecord(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return isRecord(metadata?.agentRunEvent) ? metadata.agentRunEvent : null;
}

function projectOperationResult(value: unknown): VaultOperationResult | null {
  if (!isRecord(value)
    || typeof value.operationId !== 'string'
    || !isOperationType(value.type)
    || !isOperationStatus(value.status)
    || typeof value.startedAt !== 'number'
    || !Number.isFinite(value.startedAt)
    || typeof value.finishedAt !== 'number'
    || !Number.isFinite(value.finishedAt)
    || (value.readback !== undefined && !isRecord(value.readback))
    || (value.error !== undefined && typeof value.error !== 'string')
    || (value.rollbackError !== undefined && typeof value.rollbackError !== 'string')) {
    return null;
  }
  return {
    operationId: value.operationId,
    type: value.type,
    status: value.status,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    ...(value.readback === undefined ? {} : { readback: cloneJson(value.readback) }),
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.rollbackError === undefined ? {} : { rollbackError: value.rollbackError })
  };
}

function isOperationType(value: unknown): value is VaultOperationResult['type'] {
  return value === 'move'
    || value === 'archive'
    || value === 'setProperty'
    || value === 'replaceAnchored';
}

function isOperationStatus(value: unknown): value is VaultOperationResult['status'] {
  return value === 'succeeded'
    || value === 'failed'
    || value === 'blocked_dependency'
    || value === 'readback_failed'
    || value === 'rolled_back'
    || value === 'rollback_failed';
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RunConversation {
  id: string;
  messages: ConversationMessage[];
  metadata: Record<string, unknown>;
}

function toRunConversation(conversation: IndividualConversation): RunConversation {
  return {
    id: conversation.id,
    messages: conversation.messages,
    metadata: isRecord(conversation.metadata) ? conversation.metadata : {}
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
