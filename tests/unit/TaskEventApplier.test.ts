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
