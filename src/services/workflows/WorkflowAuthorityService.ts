import type { App } from 'obsidian';
import { NEXUS_DEVICE_ID_STORAGE_KEY } from '../../database/storage/JSONLWriter';
import type { WorkflowExecutionConfig } from '../../database/types/workspace/WorkspaceTypes';

export class WorkflowAuthorityService {
  constructor(private readonly app: Pick<App, 'loadLocalStorage'>) {}

  currentDeviceId(): string {
    const stored = this.app.loadLocalStorage(NEXUS_DEVICE_ID_STORAGE_KEY) as unknown;
    if (typeof stored !== 'string' || stored.trim().length === 0) {
      throw new Error('Local Nexus device identity is unavailable');
    }
    return stored;
  }

  assertCanRun(execution: WorkflowExecutionConfig): string {
    if (execution.authorityScope !== 'vault-synced') {
      throw new Error('Machine-local workflow execution is not supported');
    }

    const authorityDeviceId = execution.authorityDeviceId?.trim();
    if (!authorityDeviceId) {
      throw new Error('Workflow authority device is required');
    }

    const currentDeviceId = this.currentDeviceId();
    if (authorityDeviceId !== currentDeviceId) {
      throw new Error('Workflow authority device mismatch');
    }
    return currentDeviceId;
  }
}
