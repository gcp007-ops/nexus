# OFFERINGS.md

Manifest vivo dos refinamentos locais aguardando decisão upstream. Uma linha por refinamento, atualizado quando o estado muda.

Propósito: quando `ProfSynapse` convidar PR para uma issue, o bundle de commits a oferecer é trivialmente computável via `git log --grep 'Ref: #N'` — sem reler logs ou reconstruir história.

**Source of truth de tracking amplo** (issues abertas, ciclos, decisões): [[NexusAdequacao-INI]] no vault ThinkBox.

---

## Active offerings

_None — fork está em paridade funcional com upstream `5.8.7`. Sem branch-offering ativa. #190 segue OPEN upstream com diagnóstico empírico atualizado (hydration race) — sem fix local oferecido (deferido para maintainer)._

---

## History

- **2026-04-28** — v5.8.7 absorbeu #185+#186 close-requests (ambos closed pelo maintainer 18:18) e introduziu PR #191 "Fix workspace state tool flows" (commit `6958856` por `Professor Synapse`, autoria reescrita autonomamente, 47 arquivos: refactor de `MemoryService.getStates` + `createState` + `loadState` + `listStates` + `WorkspaceService` + `WorkspaceStateService`, novo `tests/unit/WorkspaceDataFetcher.test.ts` ADDED com 190 linhas). Bump v5.8.7 commit `ac5da9ee`. **Sobre #190:** PR #191 melhorou writes mas não fechou. Investigação local com instrumentation file-based (logs em `/tmp/f3-dbg.log` via `fs.appendFileSync`) revelou que o defeito real é **hydration race** em `withReadableBackend` (`src/services/helpers/DualBackendExecutor.ts:98`): durante janela ~30-60s pós-reload do Obsidian, `HybridStorageAdapter.isQueryReady()` retorna `false` enquanto SQLite hidrata; `resolveReadableAdapter` falha; reads caem no legacy backend que está stale (não tem o workspace ou tem-o sem sessions); resultado é silent empty. Comment empírico postado em #190 (issuecomment-4339963036). Branches fork `fix/loadworkspace-states-empty-defensive-filter` (commit `47392f0f`) e `investigation/f3-v587` deletadas — Fase A era fix em ponto errado (testes unitários mocks sempre tomavam adapter path; live com hydration tem outro caminho). Fix real fica com maintainer.
- **2026-04-28** — v5.8.6 absorbeu #185 (`WriteTool` YAML frontmatter validation guard) e #186 (`ContentReplaceTool` NFKC compatibility tolerance) num único commit upstream `97101be` ("Guard frontmatter writes and NFKC replace matching") por `Professor Synapse` em 2026-04-28T11:34:12Z, **autoria reescrita** (sem co-author trailer — implementação independente, não cherry-pick verbatim do nosso fork). Diff: `replace.ts` -11/+8, `write.ts` 0/+59 + tests. Bump v5.8.6 em commit `de49d797`. Branches-offering locais (`fix/content-write-yaml-frontmatter-validation` `37d9b53b` e `fix/content-replace-nfkc-normalization` `f98f25da`) deletadas — propósito esgotado. Smokes ao vivo na build oficial 5.8.6 confirmaram comportamento. Time-to-absorption: ~7h cada.
- **2026-04-25** — v5.8.5 + PR #183 (`fix/parser-replace-content-not-found-normalization`, commit `e5926a17`, base `848c39a9`) mergeado upstream em `a4d10f1` para issue #182 (`ContentReplaceTool` NFC/NFD comparator tolerance). Branch local pode ser deletada quando o operador decidir.
- **2026-04-25** — v5.8.5 absorbeu #179 (`\X` unknown-escape consume backslash, commits `1d308cbf` + `75f18123`) e #181 (`splitTopLevelSegments` whitespace-gated comma, commit `68439360`) — incorporados nas commit messages do upstream com mesma semântica do nosso fix. Branches `fix/parser-backtick-unknown-escape` e `fix/parser-split-top-level-segments-quotes` arquivadas como referência histórica. Time-to-absorption: #179 = 24h, #181 = 24h.
- **2026-04-20** — Manifest criado com bundle heredoc Layer 1 contra #166. Mesmo dia: retirado após evidência empírica (testes com material grande real) mostrar que heredoc preprocessor tinha custo recorrente não-antecipado. Alinhamento com maintainer's "Layer 2 alone or nothing".
