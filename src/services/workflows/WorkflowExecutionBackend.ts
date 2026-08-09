export type WorkflowExecutionStatus =
  | 'completed'
  | 'failed'
  | 'preflight_failed'
  | 'timed_out'
  | 'cancelled';

export interface WorkflowExecutionRequest {
  runId: string;
  prompt: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  capabilityProfile: 'vault-readonly';
}

export interface WorkflowExecutionResult {
  runId: string;
  status: WorkflowExecutionStatus;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  durationMs: number;
}

export interface WorkflowExecutionHandle {
  runId: string;
  result: Promise<WorkflowExecutionResult>;
  cancel(): Promise<void>;
}

export interface WorkflowExecutionBackend {
  start(request: WorkflowExecutionRequest): WorkflowExecutionHandle;
}
