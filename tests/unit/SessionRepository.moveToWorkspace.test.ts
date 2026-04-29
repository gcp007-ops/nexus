/**
 * SessionRepository.moveToWorkspace — direct unit coverage of the
 * load-bearing dual-write + 4-table SQLite cascade introduced in
 * commit 799ed540 (B1 of review/workspace-memory-batch).
 *
 * Project pinned norm prefers real DB over mocks. The repository layer
 * runs on top of `SQLiteCacheManager`, which is a sql.js WASM bridge —
 * a real-DB harness would require WASM init and is not currently set
 * up in jest. Existing repository tests (WorkspaceRepository,
 * TaskRepository, ProjectRepository) all use the mocked
 * RepositoryDependencies pattern; this test follows that convention.
 *
 * The test is structured to make cascade regressions visible: it
 * pins the exact SQL fragments + the JSONL event order so that
 * dropping a table from the cascade or reversing the dual-write
 * fails loudly here rather than silently leaving traces in the
 * wrong workspace.
 */

import { SessionRepository } from '../../src/database/repositories/SessionRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

interface MockSqliteCache {
  queryOne: jest.Mock;
  query: jest.Mock;
  run: jest.Mock;
  transaction: jest.Mock;
}

interface MockJsonlWriter {
  appendEvent: jest.Mock;
}

interface MockQueryCache {
  cachedQuery: jest.Mock;
  invalidateByType: jest.Mock;
  invalidateById: jest.Mock;
  invalidate: jest.Mock;
}

interface MockDeps {
  sqliteCache: MockSqliteCache;
  jsonlWriter: MockJsonlWriter;
  queryCache: MockQueryCache;
}

function createMockDeps(): MockDeps {
  return {
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      run: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(async (fn: () => Promise<unknown>) => fn())
    },
    jsonlWriter: {
      appendEvent: jest.fn().mockImplementation(async (_path: string, event: Record<string, unknown>) => ({
        id: 'evt-mock',
        timestamp: 1,
        deviceId: 'dev-1',
        ...event
      }))
    },
    queryCache: {
      cachedQuery: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    }
  };
}

const SOURCE_WORKSPACE = 'ws-source';
const TARGET_WORKSPACE = 'ws-target';
const SESSION_ID = 'session-abc';

const SESSION_ROW = {
  id: SESSION_ID,
  workspaceId: SOURCE_WORKSPACE,
  name: 'Working session',
  description: 'Original description',
  startTime: 1700000000,
  endTime: null,
  isActive: 1
};

describe('SessionRepository.moveToWorkspace', () => {
  let deps: MockDeps;
  let repo: SessionRepository;

  beforeEach(() => {
    deps = createMockDeps();
    repo = new SessionRepository(deps as unknown as RepositoryDependencies);
  });

  it('cascades the SQLite update across all four workspace-scoped tables', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    await repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE);

    const runCalls = deps.sqliteCache.run.mock.calls;
    expect(runCalls).toHaveLength(4);

    const tablesUpdated = runCalls.map(([sql]: [string]) => {
      const match = /UPDATE\s+(\w+)\s+SET/i.exec(sql);
      return match ? match[1] : null;
    });

    expect(tablesUpdated).toEqual([
      'sessions',
      'states',
      'memory_traces',
      'trace_embedding_metadata'
    ]);

    for (const [, params] of runCalls) {
      expect(params).toEqual([TARGET_WORKSPACE, SESSION_ID]);
    }

    const sessionsUpdate = runCalls[0][0] as string;
    expect(sessionsUpdate).toMatch(/WHERE\s+id\s*=\s*\?/i);
    for (const cascadeSql of runCalls.slice(1).map((c: [string]) => c[0])) {
      expect(cascadeSql).toMatch(/WHERE\s+sessionId\s*=\s*\?/i);
    }
  });

  it('writes session_updated to the source workspace JSONL and session_created to the destination, in that order', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    await repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE);

    const events = deps.jsonlWriter.appendEvent.mock.calls;
    expect(events).toHaveLength(2);

    const [firstPath, firstEvent] = events[0];
    expect(firstPath).toBe(`workspaces/ws_${SOURCE_WORKSPACE}.jsonl`);
    expect(firstEvent).toMatchObject({
      type: 'session_updated',
      workspaceId: SOURCE_WORKSPACE,
      sessionId: SESSION_ID,
      data: { workspaceId: TARGET_WORKSPACE }
    });

    const [secondPath, secondEvent] = events[1];
    expect(secondPath).toBe(`workspaces/ws_${TARGET_WORKSPACE}.jsonl`);
    expect(secondEvent).toMatchObject({
      type: 'session_created',
      workspaceId: TARGET_WORKSPACE,
      data: {
        id: SESSION_ID,
        name: SESSION_ROW.name,
        description: SESSION_ROW.description,
        startTime: SESSION_ROW.startTime
      }
    });
  });

  it('runs JSONL writes before SQLite updates within the transaction', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    const order: string[] = [];
    deps.jsonlWriter.appendEvent.mockImplementation(async (_path: string, event: Record<string, unknown>) => {
      order.push(`jsonl:${event.type as string}`);
      return { id: 'evt', timestamp: 1, deviceId: 'd', ...event };
    });
    deps.sqliteCache.run.mockImplementation(async (sql: string) => {
      const table = /UPDATE\s+(\w+)/i.exec(sql)?.[1] ?? 'unknown';
      order.push(`sqlite:${table}`);
    });

    await repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE);

    expect(order).toEqual([
      'jsonl:session_updated',
      'jsonl:session_created',
      'sqlite:sessions',
      'sqlite:states',
      'sqlite:memory_traces',
      'sqlite:trace_embedding_metadata'
    ]);
  });

  it('wraps the entire move in a single transaction so a failed cascade rolls back', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    const cascadeFailure = new Error('SQLITE_CONSTRAINT: trace_embedding_metadata.sessionId');
    deps.sqliteCache.run
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cascadeFailure);

    await expect(repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE)).rejects.toBe(cascadeFailure);

    expect(deps.sqliteCache.transaction).toHaveBeenCalledTimes(1);
    expect(deps.sqliteCache.run).toHaveBeenCalledTimes(4);
    expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledTimes(2);
  });

  it('also rolls back when the destination JSONL write fails after the source write', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    const jsonlFailure = new Error('disk full writing destination JSONL');
    deps.jsonlWriter.appendEvent
      .mockResolvedValueOnce({ id: 'evt-1', timestamp: 1, deviceId: 'd', type: 'session_updated' })
      .mockRejectedValueOnce(jsonlFailure);

    await expect(repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE)).rejects.toBe(jsonlFailure);

    expect(deps.sqliteCache.run).not.toHaveBeenCalled();
  });

  it('throws and does not write anything when the session does not exist', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(null);

    await expect(repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE))
      .rejects.toThrow(`Session not found: ${SESSION_ID}`);

    expect(deps.jsonlWriter.appendEvent).not.toHaveBeenCalled();
    expect(deps.sqliteCache.run).not.toHaveBeenCalled();
  });

  it('is a no-op when the session is already in the destination workspace', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce({
      ...SESSION_ROW,
      workspaceId: TARGET_WORKSPACE
    });

    await repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE);

    expect(deps.jsonlWriter.appendEvent).not.toHaveBeenCalled();
    expect(deps.sqliteCache.run).not.toHaveBeenCalled();
    expect(deps.sqliteCache.transaction).not.toHaveBeenCalled();
  });

  it('invalidates the per-id cache entry after a successful move', async () => {
    deps.sqliteCache.queryOne.mockResolvedValueOnce(SESSION_ROW);

    await repo.moveToWorkspace(SESSION_ID, TARGET_WORKSPACE);

    expect(deps.queryCache.invalidateById).toHaveBeenCalledWith('session', SESSION_ID);
  });
});
