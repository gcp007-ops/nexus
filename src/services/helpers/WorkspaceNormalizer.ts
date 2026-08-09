// Location: src/services/helpers/WorkspaceNormalizer.ts
// Workspace data normalization logic — migrates legacy formats to current schema.
// Extracted from WorkspaceService to isolate migration/normalization concerns.
// Used by: WorkspaceService

import { IndividualWorkspace } from '../../types/storage/StorageTypes';
import * as HybridTypes from '../../types/storage/HybridStorageTypes';
import type {
  WorkflowExecutionConfig,
  WorkflowSchedule,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';
import { v4 as uuidv4 } from '../../utils/uuid';

/**
 * Migrate legacy array-based workflow steps to string format
 * @param workspace Workspace to migrate (mutated in place)
 * @returns true if migration was performed, false otherwise
 */
export function normalizeWorkspaceData(workspace: IndividualWorkspace): boolean {
  if (!workspace.context?.workflows || workspace.context.workflows.length === 0) {
    return false;
  }

  const normalized = normalizeWorkspaceContext(workspace.context);
  workspace.context = {
    ...workspace.context,
    ...normalized.context
  };
  return normalized.changed;
}

/**
 * Normalize a workspace context object: assign workflow IDs, convert array steps
 * to strings, and normalize schedule fields.
 */
export function normalizeWorkspaceContext(context: HybridTypes.WorkspaceContext): { context: HybridTypes.WorkspaceContext; changed: boolean } {
  if (!context.workflows || context.workflows.length === 0) {
    return { context, changed: false };
  }

  let changed = false;
  const workflows = context.workflows.map((workflow) => {
    let nextWorkflow = workflow as WorkspaceWorkflow & { steps: string | string[] };

    if (Array.isArray(nextWorkflow.steps)) {
      nextWorkflow = { ...nextWorkflow, steps: nextWorkflow.steps.join('\n') };
      changed = true;
    }

    if (!nextWorkflow.id) {
      nextWorkflow = { ...nextWorkflow, id: uuidv4() };
      changed = true;
    }

    const normalizedSchedule = normalizeWorkflowSchedule(nextWorkflow.schedule);
    if (normalizedSchedule !== nextWorkflow.schedule) {
      nextWorkflow = { ...nextWorkflow, schedule: normalizedSchedule };
      changed = true;
    }

    if (nextWorkflow.execution !== undefined) {
      const normalizedExecution = normalizeWorkflowExecution(nextWorkflow.execution);
      if (normalizedExecution) {
        nextWorkflow = { ...nextWorkflow, execution: normalizedExecution };
      } else {
        const workflowWithoutExecution = { ...nextWorkflow };
        delete workflowWithoutExecution.execution;
        nextWorkflow = workflowWithoutExecution;
      }
      changed = true;
    }

    return nextWorkflow as WorkspaceWorkflow;
  });

  return {
    context: {
      ...context,
      workflows
    },
    changed
  };
}

/**
 * Normalize a workflow schedule: clamp numeric fields to valid ranges,
 * default enabled to true, default catchUp to 'skip'.
 */
export function normalizeWorkflowSchedule(schedule?: WorkflowSchedule): WorkflowSchedule | undefined {
  if (!schedule) {
    return undefined;
  }

  const normalized: WorkflowSchedule = {
    enabled: schedule.enabled !== false,
    frequency: schedule.frequency,
    catchUp: schedule.catchUp || 'skip'
  };

  if (schedule.intervalHours !== undefined) {
    normalized.intervalHours = Math.max(1, Math.min(24, Number(schedule.intervalHours) || 1));
  }
  if (schedule.hour !== undefined) {
    normalized.hour = Math.max(0, Math.min(23, Number(schedule.hour) || 0));
  }
  if (schedule.minute !== undefined) {
    normalized.minute = Math.max(0, Math.min(59, Number(schedule.minute) || 0));
  }
  if (schedule.dayOfWeek !== undefined) {
    normalized.dayOfWeek = Math.max(0, Math.min(6, Number(schedule.dayOfWeek) || 0));
  }
  if (schedule.dayOfMonth !== undefined) {
    normalized.dayOfMonth = Math.max(1, Math.min(31, Number(schedule.dayOfMonth) || 1));
  }

  return normalized;
}

/**
 * Normalize the supervised-execution contract without inferring a configuration
 * for existing chat workflows. Invalid persisted blocks are discarded.
 */
export function normalizeWorkflowExecution(execution: unknown): WorkflowExecutionConfig | undefined {
  if (!isExecutionRecord(execution)
    || (execution.backend !== 'chat' && execution.backend !== 'claude-cli')
    || execution.mode !== 'proposal'
    || execution.capabilityProfile !== 'vault-readonly'
    || execution.outputSchema !== 'vault-change-plan/v1'
    || execution.approvalRequired !== true
    || !isFiniteNumber(execution.maxTurns)
    || !isFiniteNumber(execution.timeoutMinutes)
    || (execution.model !== undefined && typeof execution.model !== 'string')) {
    return undefined;
  }

  const model = execution.model?.trim();
  const authorityDeviceId = typeof execution.authorityDeviceId === 'string'
    ? execution.authorityDeviceId.trim()
    : '';

  return {
    backend: execution.backend,
    authorityScope: execution.authorityScope === 'machine-local' ? 'machine-local' : 'vault-synced',
    ...(authorityDeviceId ? { authorityDeviceId } : {}),
    ...(model ? { model } : {}),
    mode: 'proposal',
    capabilityProfile: 'vault-readonly',
    outputSchema: 'vault-change-plan/v1',
    maxTurns: clampInteger(execution.maxTurns, 1, 40),
    timeoutMinutes: clampInteger(execution.timeoutMinutes, 1, 60),
    approvalRequired: true
  };
}

function isExecutionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
