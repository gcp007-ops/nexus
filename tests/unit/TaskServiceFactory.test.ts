import { getSharedTaskService } from '../../src/agents/taskManager/services/TaskServiceFactory';
import type { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';

function storage(): HybridStorageAdapter {
  return {
    projects: {}, tasks: {}, cache: {},
    waitForQueryReady: jest.fn(async () => true),
    isReady: jest.fn(() => true),
  } as unknown as HybridStorageAdapter;
}

describe('shared task service factory', () => {
  it('returns the same service to independent callers using one storage adapter', () => {
    const adapter = storage();
    expect(getSharedTaskService(adapter)).toBe(getSharedTaskService(adapter));
  });

  it('does not share service or readiness state across different adapters', () => {
    expect(getSharedTaskService(storage())).not.toBe(getSharedTaskService(storage()));
  });

  it('refuses a query when hydration is unavailable instead of returning stale data', async () => {
    const adapter = storage();
    jest.mocked(adapter.waitForQueryReady).mockResolvedValue(false);
    await expect(getSharedTaskService(adapter).listTasks('project')).rejects.toThrow('not ready');
  });
});
