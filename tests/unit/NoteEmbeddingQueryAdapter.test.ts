import { NoteEmbeddingService } from '../../src/services/embeddings/NoteEmbeddingService';
import { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import { EmbeddingAdapter, type QueryAdapter } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

/**
 * Apply-point coverage for PR2: the query-side adapter is applied in
 * semanticSearch, and the shipped identity adapter changes nothing.
 */
function makeService(adapter: QueryAdapter | undefined, engineOutput: Float32Array) {
  const db = { query: jest.fn().mockResolvedValue([]) };
  const engine = { generateEmbedding: jest.fn().mockResolvedValue(engineOutput) };
  const service = new NoteEmbeddingService({} as never, db as never, engine as never, adapter);
  return { service, db, engine };
}

const queryBufferArg = (db: { query: jest.Mock }): Buffer =>
  db.query.mock.calls[0][1][0] as Buffer;

describe('NoteEmbeddingService query adapter', () => {
  it('passes the raw query vector through unchanged under the identity adapter', async () => {
    const engineOutput = new Float32Array([0.1, 0.2, 0.3]);
    const { service, db } = makeService(EmbeddingAdapter.identity(), engineOutput);

    await service.semanticSearch('graph theory', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(engineOutput.buffer));
  });

  it('defaults to identity when no adapter is supplied', async () => {
    const engineOutput = new Float32Array([0.4, 0.5, 0.6]);
    const { service, db } = makeService(undefined, engineOutput);

    await service.semanticSearch('q', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(engineOutput.buffer));
  });

  it('uses the adapter-transformed vector for the KNN query', async () => {
    const engineOutput = new Float32Array([1, 0, 0]);
    const transformed = new Float32Array([0, 1, 0]);
    const adapter: QueryAdapter = {
      isIdentity: false,
      version: 1,
      transform: jest.fn().mockReturnValue(transformed)
    };
    const { service, db, engine } = makeService(adapter, engineOutput);

    await service.semanticSearch('q', 5);

    expect(adapter.transform).toHaveBeenCalledWith(engineOutput);
    expect(queryBufferArg(db)).toEqual(Buffer.from(transformed.buffer));
    expect(engine.generateEmbedding).toHaveBeenCalledWith('q');
  });

  it('swaps the adapter at runtime via setQueryAdapter', async () => {
    const engineOutput = new Float32Array([1, 0, 0]);
    const transformed = new Float32Array([0, 0, 1]);
    const { service, db } = makeService(undefined, engineOutput);
    service.setQueryAdapter({ isIdentity: false, version: 2, transform: () => transformed });

    await service.semanticSearch('q', 5);

    expect(queryBufferArg(db)).toEqual(Buffer.from(transformed.buffer));
  });
});

describe('NoteEmbeddingService semantic path scope', () => {
  it('propagates exact allowed paths through the EmbeddingService facade', async () => {
    const facade = new EmbeddingService({} as never, {} as never, {} as never);
    const semanticSearch = jest.fn().mockResolvedValue([]);
    (facade as unknown as { noteService: { semanticSearch: typeof semanticSearch } }).noteService = {
      semanticSearch
    };

    await facade.semanticSearch('policy', 4, ['_Base/policy.md']);

    expect(semanticSearch).toHaveBeenCalledWith('policy', 4, ['_Base/policy.md']);
  });

  it('returns immediately when the explicit allowed set is empty', async () => {
    const { service, db, engine } = makeService(undefined, new Float32Array([1, 0]));

    await expect(service.semanticSearch('policy', 5, [])).resolves.toEqual([]);

    expect(engine.generateEmbedding).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('restricts a scoped vector query with parameterized exact paths', async () => {
    const { service, db } = makeService(undefined, new Float32Array([1, 0]));

    await service.semanticSearch('policy', 2, ['_Base/a.md', '_Base/b.md']);

    const [sql, queryParams] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE em.notePath IN (?, ?)');
    expect(queryParams.slice(1)).toEqual(['_Base/a.md', '_Base/b.md', 6]);
  });

  it('chunks large scopes, merges every batch, reranks globally, and slices only at the end', async () => {
    const engineOutput = new Float32Array([1, 0]);
    const allowedPaths = Array.from({ length: 901 }, (_, index) => `Scope/path-${index}.md`);
    allowedPaths[900] = 'Scope/target.md';
    const db = {
      query: jest.fn(async (_sql: string, queryParams: unknown[]) => {
        const paths = queryParams.slice(1, -1) as string[];
        if (paths.includes('Scope/target.md')) {
          return [{ notePath: 'Scope/target.md', distance: 0.25, updated: 0 }];
        }
        return [{ notePath: 'Scope/ordinary.md', distance: 0.21, updated: 0 }];
      })
    };
    const engine = { generateEmbedding: jest.fn().mockResolvedValue(engineOutput) };
    const service = new NoteEmbeddingService({} as never, db as never, engine as never);

    const results = await service.semanticSearch('target', 1, allowedPaths);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.every(([, queryParams]) => queryParams.length <= 902)).toBe(true);
    expect(results).toEqual([{ notePath: 'Scope/target.md', distance: 0.2, originalDistance: 0.25 }]);
  });

  it('preserves the original single global query when no scope is supplied', async () => {
    const { service, db } = makeService(undefined, new Float32Array([1, 0]));

    await service.semanticSearch('policy', 5);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, queryParams] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('WHERE em.notePath IN');
    expect(queryParams).toHaveLength(2);
    expect(queryParams[1]).toBe(15);
  });
});
