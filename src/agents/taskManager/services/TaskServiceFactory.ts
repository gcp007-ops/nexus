/** One task facade per storage lifetime, shared by tools and interactive views. */
import type { HybridStorageAdapter } from '../../../database/adapters/HybridStorageAdapter';
import { resolveWorkspaceId } from '../../../database/sync/resolveWorkspaceId';
import { TaskBoardEvents } from '../../../services/task/TaskBoardEvents';
import { DAGService } from './DAGService';
import { TaskService } from './TaskService';
import { getTaskAuthorityRuntime } from '../authority/TaskAuthorityRuntime';

const services = new WeakMap<HybridStorageAdapter, TaskService>();

export function getSharedTaskService(adapter: HybridStorageAdapter): TaskService {
  const existing = services.get(adapter);
  if (existing) return existing;
  const service = new TaskService(
    adapter.projects,
    adapter.tasks,
    new DAGService(),
    async identifier => {
      const result = await resolveWorkspaceId(identifier, adapter.cache);
      if (result.matchingIds && result.matchingIds.length > 1) {
        throw new Error(result.warning ?? 'Ambiguous workspace identity');
      }
      return result.id;
    },
    TaskBoardEvents,
    async () => typeof adapter.waitForQueryReady === 'function'
      ? adapter.waitForQueryReady()
      : adapter.isReady(),
    getTaskAuthorityRuntime(adapter),
  );
  services.set(adapter, service);
  return service;
}
