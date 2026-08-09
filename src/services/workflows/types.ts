import type {
  WorkflowCapabilityProfile,
  WorkflowExecutionBackend,
  WorkflowSchedule,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'applying'
  | 'completed'
  | 'completed_with_issues'
  | 'rejected'
  | 'preflight_failed'
  | 'security_blocked'
  | 'invalid_output'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export type AgentRunTrigger = 'manual' | 'schedule';

export interface AgentRunMetadata {
  backend: Extract<WorkflowExecutionBackend, 'claude-cli'>;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  model: string;
  mode: 'proposal';
  capabilityProfile: WorkflowCapabilityProfile;
  outputSchema: 'vault-change-plan/v1';
  approvalRequired: true;
  maxTurns: number;
  timeoutMinutes: number;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  promptHash: string;
  workflowHash: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  planHash?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface AgentRunRecord extends AgentRunMetadata {
  runId: string;
  conversationId: string;
}

export interface WorkflowRunMetadata {
  promptId?: string;
  workflowId?: string;
  workflowName?: string;
  runTrigger?: 'manual' | 'scheduled' | 'catch_up';
  scheduledFor?: number;
  runKey?: string;
}

export interface WorkflowRunRequest extends WorkflowRunMetadata {
  workspaceId: string;
  workflowId: string;
  openInChat?: boolean;
}

export interface WorkflowRunResult {
  conversationId: string;
  sessionId?: string;
  runId?: string;
}

export interface DueWorkflowSlot {
  timestamp: number;
  isCatchUp: boolean;
}

export function formatWorkflowScheduleSummary(schedule?: WorkflowSchedule): string {
  if (!schedule?.enabled) {
    return 'Manual only';
  }

  switch (schedule.frequency) {
    case 'hourly':
      return `Every ${schedule.intervalHours || 1} hour${(schedule.intervalHours || 1) === 1 ? '' : 's'}`;
    case 'daily':
      return `Daily at ${formatHourMinute(schedule.hour, schedule.minute)}`;
    case 'weekly':
      return `Weekly on ${formatDayOfWeek(schedule.dayOfWeek)} at ${formatHourMinute(schedule.hour, schedule.minute)}`;
    case 'monthly':
      return `Monthly on day ${schedule.dayOfMonth || 1} at ${formatHourMinute(schedule.hour, schedule.minute)}`;
    default:
      return 'Manual only';
  }
}

export function buildWorkflowRunTitle(workspaceName: string, workflowName: string, scheduledFor: number): string {
  return `[${workspaceName} - ${workflowName} - ${formatRunTimestamp(scheduledFor)}]`;
}

export function formatRunTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function buildWorkflowKickoffMessage(
  workflow: WorkspaceWorkflow,
  runTrigger: 'manual' | 'scheduled' | 'catch_up',
  scheduledFor: number
): string {
  return [
    `Run workflow: ${workflow.name}`,
    `When: ${workflow.when}`,
    'Steps:',
    workflow.steps,
    `Trigger: ${runTrigger}`,
    `Scheduled for: ${formatRunTimestamp(scheduledFor)}`
  ].join('\n\n');
}

function formatHourMinute(hour?: number, minute?: number): string {
  const safeHour = Math.max(0, Math.min(23, hour ?? 0));
  const safeMinute = Math.max(0, Math.min(59, minute ?? 0));
  return `${String(safeHour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}`;
}

function formatDayOfWeek(dayOfWeek?: number): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayOfWeek ?? 0] || days[0];
}
