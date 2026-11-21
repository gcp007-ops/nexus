/**
 * Location: src/database/repositories/TaskProjectionHealer.ts
 *
 * Heals the SQL projection of ONE admitted project whose current hash diverged
 * from the operationalHash the authority journal recorded. The admitted
 * baseline is rebuilt from the project's legacy JSONL events and checked
 * against state.baselineHash; then every committed delta is reapplied and
 * checked against its own operationalHash. Any mismatch rolls the whole
 * transaction back and the caller keeps refusing: the heal never guesses.
 *
 * Why it cannot lose a foreign write: the legacy events enter without any time
 * filter, so an uncoordinated write made after admission changes the rebuilt
 * baseline and the baseline check refuses.
 */
import type { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import { TaskEventApplier } from '../sync/TaskEventApplier';
import { purgeProjectRows } from '../taskOwnership';
import { operationalSnapshot, projectHash } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
import type { AuthorityProjectState, CoordinationCommittedEvent, OperationalTaskEvent } from './interfaces/ITaskCoordinationRepository';

export const HEAL_MARKER = 'task-projection-heal/v1';
class HealRefused extends Error {}

/** Same deterministic order as ReconcilePipeline: (timestamp, deviceId, id). */
function orderLegacy(events: OperationalTaskEvent[]): OperationalTaskEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp
    || (a.deviceId ?? '').localeCompare(b.deviceId ?? '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Returns true only when the projection now matches the journal. Returns
 * false, with every row untouched, when the heal is refused. */
export async function healProjection(
  cache: SQLiteCacheManager,
  projectId: string,
  history: CoordinationCommittedEvent[],
  legacy: OperationalTaskEvent[],
  getState: () => Promise<AuthorityProjectState | null>
): Promise<boolean> {
  const ordered = orderLegacy(legacy);
  const committed = [...history].sort((a, b) => a.revision - b.revision);
  try {
    return await cache.transaction(async () => {
      const state = await getState();
      // The journal read must reach the projected revision.
      if (!state?.admitted || !committed.length || committed[committed.length - 1].revision !== state.revision) throw new HealRefused('journal behind projection');
      // A child task in another project would be detached by the purge.
      if ((await operationalSnapshot(cache, projectId)).length !== 4) throw new HealRefused('child task in another project');
      const cross = await cache.query(
        'SELECT 1 FROM task_dependencies d JOIN tasks a ON a.id=d.taskId JOIN tasks b ON b.id=d.dependsOnTaskId WHERE (a.projectId=?) <> (b.projectId=?) LIMIT 1',
        [projectId, projectId]
      );
      if (cross.length) throw new HealRefused('cross-project dependency');
      await purgeProjectRows(cache, projectId);
      const applier = new TaskEventApplier(cache);
      await applier.applyLegacyReconstruction(ordered);
      if (await projectHash(cache, projectId) !== state.baselineHash) throw new HealRefused('baseline');
      for (const event of committed) {
        if (event.receipt.error) continue;
        await applier.applyCoordinatedDelta(event);
        if (await projectHash(cache, projectId) !== event.state.operationalHash) throw new HealRefused('delta readback');
      }
      for (const event of ordered) await cache.markEventApplied(event.id);
      console.warn(`[TaskCoordination] ${HEAL_MARKER} ${projectId} revision ${state.revision} legacy ${ordered.length}`);
      return true;
    });
  } catch (error) {
    if (error instanceof HealRefused) {
      console.warn(`[TaskCoordination] ${HEAL_MARKER} refused ${projectId}: ${error.message}`);
      return false;
    }
    throw error;
  }
}
