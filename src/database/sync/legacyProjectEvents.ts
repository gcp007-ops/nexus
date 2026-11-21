/**
 * Location: src/database/sync/legacyProjectEvents.ts
 *
 * Selects, from the legacy task JSONL streams, the events that built ONE
 * project's rows. Used only by the projection heal (TaskProjectionHealer),
 * which rebuilds that project and checks the result against the admitted
 * baseline hash, so a wrong selection is refused there instead of persisted.
 *
 * A task that changed project cannot be attributed to one project without
 * guessing; the selection refuses with `heal_unsupported` instead.
 */
import type { TaskEvent } from '../interfaces/StorageEvents';
import type { OperationalTaskEvent } from '../repositories/interfaces/ITaskCoordinationRepository';

export function selectProjectEvents(events: TaskEvent[], projectId: string): OperationalTaskEvent[] {
  const ordered = events
    .filter((event): event is OperationalTaskEvent => !!event && event.type !== 'project_coordination_committed')
    .sort((a, b) => a.timestamp - b.timestamp
      || (a.deviceId ?? '').localeCompare(b.deviceId ?? '')
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const owner = new Map<string, string>();
  for (const event of ordered) {
    if (event.type === 'task_created' && event.data?.id && event.data.projectId) {
      const previous = owner.get(event.data.id);
      if (previous !== undefined && previous !== event.data.projectId && (previous === projectId || event.data.projectId === projectId)) throw new Error('heal_unsupported: task changed project');
      owner.set(event.data.id, event.data.projectId);
    } else if (event.type === 'task_updated' && event.data?.projectId !== undefined) {
      const previous = owner.get(event.taskId);
      if (previous !== event.data.projectId && (previous === projectId || event.data.projectId === projectId)) throw new Error('heal_unsupported: task changed project');
    }
  }
  return ordered.filter(event => {
    switch (event.type) {
      case 'project_created': return event.data?.id === projectId;
      case 'project_updated':
      case 'project_deleted': return event.projectId === projectId;
      case 'task_created': return event.data?.projectId === projectId;
      default: return owner.get(event.taskId) === projectId;
    }
  });
}
