/**
 * SearchContentTool — keyword path ranking and match provenance.
 *
 * Background: `searchInFile` scores a fuzzy match on the FILENAME as
 *   fuzzyScore = clamp(1 + fuzzyResult.score / 100)
 * Obsidian's fuzzy scores are small negatives for scattered subsequence
 * matches, so a weak filename match lands around 0.95 — above the 0.9 ceiling
 * that `performKeywordSearch` assigns to an EXACT PHRASE match in the body.
 *
 * Consequence: a file that does not contain the query at all can outrank a
 * file that contains it verbatim, and the response gives the caller no way to
 * tell the two apart.
 */

import { TFile } from 'obsidian';
import type { Plugin } from 'obsidian';

// Obsidian's `prepareFuzzySearch` is not part of the shared mock. Scores are
// driven per-test through this table, keyed by the text handed to the matcher.
const mockFuzzyScores: Record<string, number> = {};

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return {
    ...actual,
    prepareFuzzySearch: () => (text: string) => {
      const score = mockFuzzyScores[text];
      return score === undefined ? null : { score };
    }
  };
});

import { SearchContentTool } from '../../src/agents/searchManager/tools/searchContent';

const DECOY = 'Zettel/teorias-sobre-privacidade-e-vigilancia.md';
const REAL = 'Julgados/STF-ADI-6649.md';

/** Body of DECOY deliberately contains neither query term. */
const DECOY_BODY = 'Ha teorias que reconhecem a privacidade como espaco intangivel.';
/** Body of REAL contains the query as an exact phrase. */
const REAL_BODY = 'Ementa: o acordao ministro relator assentou a tese do compartilhamento.';

/**
 * `prepareResult` nests the payload under `data`, while `ContentSearchResult`
 * declares `results` at the top level. Read through both so these tests assert
 * on behaviour rather than on which of the two shapes is in force.
 */
type ResultEntry = { filePath: string; content?: string; matchType?: string };
function resultsOf(result: unknown): ResultEntry[] {
  const record = result as { results?: ResultEntry[]; data?: { results?: ResultEntry[] } };
  return record.results ?? record.data?.results ?? [];
}

function makePlugin(files: Array<{ path: string; content: string }>): Plugin {
  const tfiles = files.map(f => new TFile(f.path.split('/').pop() as string, f.path));
  const bodies = new Map(files.map(f => [f.path, f.content]));

  return {
    app: {
      vault: {
        getMarkdownFiles: () => tfiles,
        read: async (file: TFile) => bodies.get(file.path) ?? ''
      },
      metadataCache: {
        getFileCache: () => null
      }
    }
  } as unknown as Plugin;
}

describe('SearchContentTool — keyword search', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFuzzyScores)) delete mockFuzzyScores[key];
  });

  it('ranks an exact content match above a filename-only fuzzy match', async () => {
    // The decoy's filename matches weakly; the real hit's filename does not match at all.
    mockFuzzyScores['teorias-sobre-privacidade-e-vigilancia'] = -5;

    const tool = new SearchContentTool(makePlugin([
      { path: DECOY, content: DECOY_BODY },
      { path: REAL, content: REAL_BODY }
    ]));

    const result = await tool.execute({ query: 'acordao ministro', limit: 10 });

    expect(result.success).toBe(true);
    expect(resultsOf(result)[0].filePath).toBe(REAL);
  });

  it('reports how each result matched', async () => {
    mockFuzzyScores['teorias-sobre-privacidade-e-vigilancia'] = -5;

    const tool = new SearchContentTool(makePlugin([
      { path: DECOY, content: DECOY_BODY },
      { path: REAL, content: REAL_BODY }
    ]));

    const result = await tool.execute({ query: 'acordao ministro', limit: 10 });

    const entries = resultsOf(result);
    const real = entries.find(r => r.filePath === REAL);
    const decoy = entries.find(r => r.filePath === DECOY);

    expect(real).toHaveProperty('matchType', 'content');
    expect(decoy).toHaveProperty('matchType', 'path');
  });

  it('documents matchType in the result schema so MCP callers can rely on it', () => {
    const tool = new SearchContentTool(makePlugin([]));

    const schema = tool.getResultSchema() as unknown as {
      properties: { results: { items: { properties: Record<string, { enum?: string[] }> } } };
    };
    const itemProps = schema.properties.results.items.properties;

    expect(itemProps).toHaveProperty('matchType');
    expect(itemProps.matchType.enum).toEqual(['content', 'path']);
  });

  // Non-regression lock: this already holds on the unpatched build and must
  // keep holding. The empty result is the only honest "not found" signal the
  // tool has, and the fix must not start padding the list.
  it('returns nothing when no file matches by content or by name', async () => {
    const tool = new SearchContentTool(makePlugin([
      { path: DECOY, content: DECOY_BODY },
      { path: REAL, content: REAL_BODY }
    ]));

    const result = await tool.execute({ query: 'zblorquefting nimbulastro', limit: 5 });

    expect(result.success).toBe(true);
    expect(resultsOf(result)).toHaveLength(0);
  });
});
