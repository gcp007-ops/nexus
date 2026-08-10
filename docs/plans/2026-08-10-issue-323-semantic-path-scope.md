# Issue #323 Semantic Path Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `search content --semantic --paths` rank the complete allowed path population before applying the caller's result limit.

**Architecture:** `SearchContentTool` resolves the existing literal-prefix and glob path semantics against the vault's Markdown files before vector retrieval, then passes the resulting exact note paths through `EmbeddingService` to `NoteEmbeddingService`. The note service keeps the unscoped query byte-for-byte equivalent, while scoped searches query exact paths in SQLite-safe chunks, combine chunk candidates, apply the existing recency/title reranker globally, and slice only at the end.

**Tech Stack:** TypeScript 6, Jest 29, Obsidian API mocks, SQLite vec queries through `SQLiteCacheManager`.

## Global Constraints

- Preserve the current unscoped semantic-search behavior and SQL shape.
- Preserve existing literal-prefix, root-path, and glob semantics from `searchContent.ts`.
- Use parameterized SQL only; each scoped query must stay below SQLite's bind-variable limit.
- Keep the plugin mobile-safe: no new Node.js imports or desktop-only module initialization.
- Do not alter deploy, release, manifest, ThinkBox, or unrelated baseline failures.

---

### Task 1: Resolve semantic path scope before retrieval

**Files:**
- Modify: `tests/unit/SearchContentTool.test.ts`
- Modify: `src/agents/searchManager/tools/searchContent.ts`

**Interfaces:**
- Consumes: `ContentSearchParams.paths?: string[]`, `isGlobPattern`, `globToRegex`, and `normalizePath`.
- Produces: `EmbeddingService.semanticSearch(query: string, limit?: number, allowedNotePaths?: readonly string[]): Promise<SimilarNote[]>` calls containing the exact allowed Markdown paths.

- [x] **Step 1: Write failing semantic-scope tests**

Add a semantic tool fixture with real `TFile` instances and a fake embedding service. Assert that literal folder prefixes and glob expressions are resolved before `semanticSearch`, that a target omitted from a simulated global top set is returned when it is in the allowed set, and that a scope matching no Markdown files returns a successful empty result.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --runInBand tests/unit/SearchContentTool.test.ts`

Expected: FAIL because `semanticSearch` receives only `(query, limit * 2)`, so no exact path set reaches vector retrieval and the empty scoped result is reported as a vector-database error.

- [x] **Step 3: Implement pre-retrieval scope resolution**

Extract the existing path predicate into a private helper that filters `plugin.app.vault.getMarkdownFiles()`. For semantic searches with a non-empty `paths` parameter, resolve exact allowed paths and call:

```ts
await embeddingService.semanticSearch(searchParams.query, searchParams.limit, allowedNotePaths);
```

For an unscoped search, preserve the existing `semanticSearch(query, limit * 2)` call without an allowed-path argument. Treat an empty result from an explicit scope as a successful empty result; preserve the existing unscoped empty-result error.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/SearchContentTool.test.ts`

Expected: PASS.

### Task 2: Propagate and execute exact scoped vector retrieval

**Files:**
- Modify: `tests/unit/NoteEmbeddingQueryAdapter.test.ts`
- Modify: `src/services/embeddings/EmbeddingService.ts`
- Modify: `src/services/embeddings/NoteEmbeddingService.ts`

**Interfaces:**
- Consumes: optional `allowedNotePaths?: readonly string[]` from `SearchContentTool`.
- Produces: `NoteEmbeddingService.semanticSearch(query: string, limit?: number, allowedNotePaths?: readonly string[]): Promise<SimilarNote[]>`.

- [x] **Step 1: Write failing service tests**

Assert that an explicit empty allowed set skips embedding and SQL work, one scoped set generates parameterized `IN` SQL, more than 900 allowed paths produces multiple bounded queries, candidates from all chunks are merged and reranked globally before the final slice, and omitting the allowed set retains the original unscoped SQL and single query.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --runInBand tests/unit/NoteEmbeddingQueryAdapter.test.ts`

Expected: FAIL because neither service accepts or applies `allowedNotePaths` and the current query is always global.

- [x] **Step 3: Add facade propagation and chunked scoped SQL**

Extend both service signatures with `allowedNotePaths?: readonly string[]`. In `NoteEmbeddingService`, return immediately for an explicit empty array. Leave the existing unscoped query unchanged. For scoped input, split paths into chunks of at most 900 entries and execute, for each chunk, a parameterized query shaped as:

```sql
WHERE em.notePath IN (?, ...)
ORDER BY distance
LIMIT ?
```

Pass `[queryBuffer, ...pathChunk, candidateLimit]`, merge every chunk's candidates, run the existing recency/title scoring once over the merged collection, sort globally, and then apply `slice(0, limit)`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/NoteEmbeddingQueryAdapter.test.ts tests/unit/SearchContentTool.test.ts`

Expected: PASS.

### Task 3: Verify the patch and record an intentional commit

**Files:**
- Verify: all files modified in Tasks 1-2

**Interfaces:**
- Consumes: completed scoped semantic-search behavior.
- Produces: a clean commit on `fix/semantic-path-scope-5163`.

- [x] **Step 1: Run focused and adjacent tests**

Run: `npm test -- --runInBand tests/unit/SearchContentTool.test.ts tests/unit/NoteEmbeddingQueryAdapter.test.ts`

Expected: PASS with no new warnings or failures.

- [x] **Step 2: Run static and production-build verification**

Run: `npm run build`

Expected: PASS.

- [x] **Step 3: Inspect the complete diff**

Run: `git diff --check && git diff --stat && git diff`

Expected: no whitespace errors and changes limited to the plan, two search/embedding services, facade, and focused tests.

- [x] **Step 4: Commit intentionally**

Run:

```bash
git add docs/plans/2026-08-10-issue-323-semantic-path-scope.md \
  src/agents/searchManager/tools/searchContent.ts \
  src/services/embeddings/EmbeddingService.ts \
  src/services/embeddings/NoteEmbeddingService.ts \
  tests/unit/SearchContentTool.test.ts \
  tests/unit/NoteEmbeddingQueryAdapter.test.ts
git commit -m "fix: scope semantic search before ranking"
```

Expected: one commit containing only issue #323.
