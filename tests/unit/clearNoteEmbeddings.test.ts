/**
 * Removing note embeddings.
 *
 * Turning `enableEmbeddings` off leaves every computed vector in the cache —
 * `EmbeddingManager` just stops initializing, and nothing deletes what is
 * already there. `clearAllData()` does not cover it either: it clears the
 * *conversation* embeddings and leaves `note_embeddings` / `embedding_metadata`
 * alone, which is correct for a rebuild (they cannot be replayed from the JSONL
 * store) but left no way to remove them at all.
 *
 * On a 43k-note vault that is ~63 MB the auto-save rewrites in full on every
 * tick, so the dead weight is a standing tax rather than idle bytes.
 */

import { SQLiteMaintenanceService } from '../../src/database/storage/SQLiteMaintenanceService';

function createService() {
  const statements: string[] = [];
  const bridge = {
    exec: jest.fn((_db: unknown, sql: string) => {
      statements.push(sql.trim());
    })
  };

  let transactionDepth = 0;
  const vacuumDepths: number[] = [];

  const service = new SQLiteMaintenanceService({
    app: {} as never,
    dbPath: 'cache.db',
    bridge: bridge as never,
    getDb: () => ({} as never),
    queryOne: jest.fn().mockResolvedValue(null) as never,
    transaction: (async <T>(fn: () => Promise<T>): Promise<T> => {
      transactionDepth += 1;
      try {
        return await fn();
      } finally {
        transactionDepth -= 1;
      }
    }) as never
  });

  // Record the transaction depth at the moment VACUUM is issued.
  const originalExec = bridge.exec;
  bridge.exec = jest.fn((db: unknown, sql: string) => {
    if (sql.trim().toUpperCase() === 'VACUUM') {
      vacuumDepths.push(transactionDepth);
    }
    return originalExec(db, sql);
  });

  return { service, statements, vacuumDepths };
}

describe('SQLiteMaintenanceService.clearNoteEmbeddings', () => {
  it('drops and recreates the vec0 table rather than deleting from it', async () => {
    const { service, statements } = createService();

    await service.clearNoteEmbeddings();

    const joined = statements.join('\n');
    expect(joined).toContain('DROP TABLE IF EXISTS note_embeddings');
    expect(joined).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0');
  });

  it('clears the metadata table that pairs with the vectors', async () => {
    const { service, statements } = createService();

    await service.clearNoteEmbeddings();

    expect(statements.join('\n')).toContain('DELETE FROM embedding_metadata');
  });

  it('reclaims the space, otherwise the file never shrinks', async () => {
    const { service, statements } = createService();

    await service.clearNoteEmbeddings();

    expect(statements.map(s => s.toUpperCase())).toContain('VACUUM');
  });

  it('runs VACUUM outside the transaction, which SQLite requires', async () => {
    const { service, vacuumDepths } = createService();

    await service.clearNoteEmbeddings();

    expect(vacuumDepths).toEqual([0]);
  });

  it('leaves conversation and trace embeddings alone', async () => {
    const { service, statements } = createService();

    await service.clearNoteEmbeddings();

    const joined = statements.join('\n');
    expect(joined).not.toContain('conversation_embeddings');
    expect(joined).not.toContain('trace_embedding');
  });

  it('does not touch the event-derived tables a rebuild owns', async () => {
    const { service, statements } = createService();

    await service.clearNoteEmbeddings();

    const joined = statements.join('\n');
    for (const table of ['workspaces', 'sessions', 'memory_traces', 'tasks', 'conversations']) {
      expect(joined).not.toContain(`DELETE FROM ${table}`);
    }
  });
});
