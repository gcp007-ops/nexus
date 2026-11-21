/**
 * Regression coverage for task events produced by older Nexus clients.
 *
 * Real synced JSONL may contain a singleton array in `notePath`. SQLite rejects
 * that runtime object as a bind value, which aborts reconciliation before later
 * events can be applied.
 */

import type { TaskEvent } from '../../src/database/interfaces/StorageEvents';
import type { ISQLiteCacheManager, SyncState } from '../../src/database/sync/SyncCoordinator';
import { TaskEventApplier } from '../../src/database/sync/TaskEventApplier';
import { selectProjectEvents } from '../../src/database/sync/legacyProjectEvents';

class StrictSQLiteCache implements ISQLiteCacheManager {
  readonly runs: Array<{ sql: string; params: unknown[] }> = [];

  async run(sql: string, params: unknown[] = []): Promise<unknown> {
    if (params.some(param => typeof param === 'object' && param !== null)) {
      throw new Error('Unsupported bind() argument type: object');
    }
    this.runs.push({ sql, params });
    return undefined;
  }

  async getSyncState(_deviceId: string): Promise<SyncState | null> { return null; }
  async updateSyncState(
    _deviceId: string,
    _lastEventTimestamp: number,
    _fileTimestamps: Record<string, number>
  ): Promise<void> {}
  async isEventApplied(_eventId: string): Promise<boolean> { return false; }
  async markEventApplied(_eventId: string): Promise<void> {}
  async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> { return []; }
  async queryOne<T>(_sql: string, _params?: unknown[]): Promise<T | null> { return null; }
  async clearAllData(): Promise<void> {}
  async rebuildFTSIndexes(): Promise<void> {}
  async save(): Promise<void> {}
}

describe('TaskEventApplier legacy note paths', () => {
  it('unwraps a singleton notePath array before binding an unlink event', async () => {
    const sqlite = new StrictSQLiteCache();
    const applier = new TaskEventApplier(sqlite);
    const event = {
      id: 'legacy-unlink-1',
      type: 'task_note_unlinked',
      deviceId: 'remote-device',
      timestamp: 1,
      taskId: 'task-1',
      notePath: ['Producao/nota.md']
    } as unknown as TaskEvent;

    await applier.apply(event);

    expect(sqlite.runs).toEqual([{
      sql: 'DELETE FROM task_note_links WHERE taskId = ? AND notePath = ?',
      params: ['task-1', 'Producao/nota.md']
    }]);
  });

  it('preserves the original string identity when unwrapping', async () => {
    const sqlite = new StrictSQLiteCache();
    const applier = new TaskEventApplier(sqlite);
    const originalPath = ' Producao/nota com espacos.md ';
    const event = {
      id: 'legacy-unlink-spaces',
      type: 'task_note_unlinked',
      deviceId: 'remote-device',
      timestamp: 2,
      taskId: 'task-1',
      notePath: [originalPath]
    } as unknown as TaskEvent;

    await applier.apply(event);

    expect(sqlite.runs[0]?.params).toEqual(['task-1', originalPath]);
    expect(event.notePath).toEqual([originalPath]);
  });

  it('treats an empty singleton the same as an empty string', async () => {
    const sqlite = new StrictSQLiteCache();
    const applier = new TaskEventApplier(sqlite);
    const event = {
      id: 'legacy-unlink-empty',
      type: 'task_note_unlinked',
      deviceId: 'remote-device',
      timestamp: 3,
      taskId: 'task-1',
      notePath: ['']
    } as unknown as TaskEvent;

    await expect(applier.apply(event)).resolves.toBeUndefined();
    expect(sqlite.runs).toEqual([]);
  });

  it('rejects an ambiguous multi-path payload before reaching SQLite', async () => {
    const sqlite = new StrictSQLiteCache();
    const applier = new TaskEventApplier(sqlite);
    const event = {
      id: 'legacy-unlink-ambiguous',
      type: 'task_note_unlinked',
      deviceId: 'remote-device',
      timestamp: 4,
      taskId: 'task-ambiguous',
      notePath: ['Producao/a.md', 'Producao/b.md']
    } as unknown as TaskEvent;

    await expect(applier.apply(event)).rejects.toThrow(
      'event legacy-unlink-ambiguous for task task-ambiguous'
    );
    expect(sqlite.runs).toEqual([]);
  });
});

describe('coordination event sequence', () => {
  it('deduplicates identical events and refuses gaps and conflicting receipts', async () => {
    const { applyCoordinationEvent } = await import('../../src/database/sync/TaskCoordinationEventApplier');
    const initial = { revision: 4, baselineHash: 'base', receipts: {} };
    const event = { previousRevision: 4, revision: 5, baselineHash: 'base', operationKey: '__proto__', signature: 'sig', result: { status: 'committed' } };
    const next = applyCoordinationEvent(initial, event);
    expect(next.revision).toBe(5);
    expect(applyCoordinationEvent(next, event)).toEqual(next);
    expect(() => applyCoordinationEvent(initial, { ...event, previousRevision: 5, revision: 6 })).toThrow();
    expect(() => applyCoordinationEvent(initial, { ...event, baselineHash: 'other' })).toThrow();
    expect(() => applyCoordinationEvent(next, { ...event, signature: 'other' })).toThrow();
  });
});

describe('coordination shard reading', () => {
  it('rejects an invalid record instead of treating a truncated shard as empty', async () => {
    const { parseCoordinationShard } = await import('../../src/database/sync/TaskCoordinationEventApplier');
    expect(parseCoordinationShard('{"type":"project_created"}\n')).toEqual([{ type: 'project_created' }]);
    expect(() => parseCoordinationShard('{"type":"project_created"}\n{"type":')).toThrow();
  });
});

describe('selectProjectEvents (projection heal source)', () => {
  const created = (id: string, projectId: string, timestamp: number) => ({ type: 'task_created', id: `c-${id}-${timestamp}`, timestamp, deviceId: 'd', data: { id, projectId, workspaceId: 'w', title: id, status: 'todo', priority: 'medium', created: timestamp, updated: timestamp } }) as unknown as TaskEvent;
  it('selects only the events that built the project', () => {
    const events = [
      { type: 'project_created', id: 'p1', timestamp: 1, deviceId: 'd', data: { id: 'p', workspaceId: 'w', name: 'p' } },
      { type: 'project_created', id: 'q1', timestamp: 1, deviceId: 'd', data: { id: 'q', workspaceId: 'w', name: 'q' } },
      created('t', 'p', 2), created('x', 'q', 2),
      { type: 'task_updated', id: 'u1', timestamp: 3, deviceId: 'd', taskId: 't', data: { title: 'T' } },
      { type: 'task_updated', id: 'u2', timestamp: 3, deviceId: 'd', taskId: 'x', data: { title: 'X' } }
    ] as unknown as TaskEvent[];
    expect(selectProjectEvents(events, 'p').map(event => event.id)).toEqual(['p1', 'c-t-2', 'u1']);
  });
  it('refuses with heal_unsupported when a task moved between projects', () => {
    const moved = [created('t', 'q', 1), { type: 'task_updated', id: 'm1', timestamp: 2, deviceId: 'd', taskId: 't', data: { projectId: 'p' } }] as unknown as TaskEvent[];
    expect(() => selectProjectEvents(moved, 'p')).toThrow('heal_unsupported');
    const away = [created('t', 'p', 1), { type: 'task_updated', id: 'm2', timestamp: 2, deviceId: 'd', taskId: 't', data: { projectId: 'q' } }] as unknown as TaskEvent[];
    expect(() => selectProjectEvents(away, 'p')).toThrow('heal_unsupported');
  });
});
