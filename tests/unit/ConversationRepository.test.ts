import { ConversationRepository } from '../../src/database/repositories/ConversationRepository';
import type { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

function createDependencies(): RepositoryDependencies {
  return {
    sqliteCache: {
      query: jest.fn(async () => [{ id: 'conversation-a' }, { id: 'conversation-b' }]),
      queryOne: jest.fn(),
      run: jest.fn(),
      transaction: jest.fn((action: () => Promise<unknown>) => action())
    } as never,
    jsonlWriter: {
      appendEvent: jest.fn()
    } as never,
    queryCache: {
      cachedQuery: jest.fn((_key: string, action: () => Promise<unknown>) => action()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    } as never
  };
}

describe('ConversationRepository', () => {
  it('returns one immutable ID-ordered snapshot without OFFSET pagination', async () => {
    const dependencies = createDependencies();
    const repository = new ConversationRepository(dependencies);

    await expect(repository.getConversationIdsSnapshot()).resolves.toEqual([
      'conversation-a',
      'conversation-b'
    ]);
    expect(dependencies.sqliteCache.query).toHaveBeenCalledWith(
      'SELECT id FROM conversations ORDER BY id ASC'
    );
  });
});
