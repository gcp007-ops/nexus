# FORK-DELTA.md

Ponteiro técnico mínimo do fork `gcp007-ops/nexus` (upstream: `ProfSynapse/nexus`). Vive junto do código para quem abre o repo saber o estado sem precisar puxar a vault.

**Source of truth de tracking amplo** (issues, decisões, política, história de ciclos): vault ThinkBox, `Producao/ThinkBox/Iniciativas/NexusAdequacao-INI/_index.md` + task guarda-chuva no taskManager (projectId `0c3c2fbb-9c3e-48ee-ad82-7342adc54aed`, workspace Desenvolvedor).

---

## Estado: zero divergência funcional (paridade 5.8.8)

Base: `origin/main` em `5.8.8` (`b3fc4340`). Bump v5.8.8 (2026-04-29T18:53Z) absorveu batch de 6 PRs: #192 (session-workspace-handle: workspaceId threading + per-workspace `sessionHandleMap` partitioning), #193 (workspace-folder-watcher + WorkspaceContextBuilder expansion + recordActivityTrace dedup), #194 (search-memory-processor expansion: CLI-trace pretty-printing + useTools result expansion), #195 (tool-batch displaySessionId/sessionName), #196 (eval-harness expansion: retry on transient + structured YAML config), e **#197 (fix #190)**.

**Sobre #190 (loadWorkspace silent empty / hydration race):** **fechado upstream** via PR #197 "fix(storage): event-based waitForQueryReady + await before legacy fallback" (commit `ffb20171`, merge `7123ebe8`). `HybridStorageAdapter.waitForQueryReady` agora é settled por phase transitions (não polling), com timeout 60s demoted a safety net; `withReadableBackend` aguarda hydration antes de cair no legacy. Smokes empíricos em v5.8.8 ao vivo (rodada warm + rodada pós Cmd+P Reload, 5x `loadWorkspace` paralelas + 1x `list-states`): 6/6 `success: true`, 0 "Workspace not found", 5/5 `data.states` populated, 0 silent empty em `listStates`. Bonus: `data.sessions` agora carrega chat sessions ativas (era `[]` em v5.8.7). Pendência minor não-bloqueante: `data.workspaceContext.workspaceId` echo no envelope continua ausente. Comment de close-request postado em [issuecomment-4347892379](https://github.com/ProfSynapse/nexus/issues/190#issuecomment-4347892379).

**Branches preservadas neste sync:** backup `backup/pre-588-sync-2026-04-29` em fork. Backups históricos de syncs anteriores mantidos.

**Zero cherry-picks funcionais.** Trinca histórica do parser CLI (#163/#165, #167, #172, #179, #181) absorvida em v5.8.5 e antes; trinca ContentManager (#182, #185, #186) absorvida em v5.8.6; refactor workspace state tools (#191) absorvido em v5.8.7; hydration race + workspace batch (#192-#197) absorvido em v5.8.8. Defects ContentManager/MemoryManager remanescentes conhecidos: nenhum.

**Meta/infra:** este arquivo + [OFFERINGS.md](./OFFERINGS.md) + [.github/workflows/upstream-sync.yml](./.github/workflows/upstream-sync.yml).

Próximos syncs upstream: fast-forward trivial esperado; sem cherry-pick recurring.

---

## Política de contribuição

**Issue-first.** Reportamos frições por **issue no upstream**; maintainer (`ProfSynapse`) cherry-picka verbatim do nosso fork ou reescreve quando quer absorver. Não abrimos PRs proativos (lição PR #161 → issue #162, 2026-04-18). Ver histórico em [[NexusAdequacao-INI]].

**Exceção:** PR para upstream **só se convidado explicitamente** (ex: #166 "Layer 2 alone if we decide to adopt"; #182 PR #183 sob autorização explícita após smokes). Nesses casos, [OFFERINGS.md](./OFFERINGS.md) tem o bundle pronto.

---

## Commit discipline

Quando surgir refinamento local ligado a issue upstream, usar trailer `Ref: #issue` no body:

```
fix(toolmanager): heredoc named premature close

[body explicando causa/fix]

Ref: ProfSynapse/nexus#166
```

Isto torna `git log --grep 'Ref: #166'` a lista canônica dos commits tocando aquela issue. Quando maintainer convidar PR, bundle é computável em 1 comando (ver OFFERINGS.md).

---

## Smoke test canônico

Rodar após qualquer sync antes de deploy:

```bash
npx jest --testPathPattern='ToolManagerCliSyntax'   # CLI parser
npx jest --silent --testPathIgnorePatterns='ModelAgentManager'  # full suite (exclui flake pré-existente)
npx tsc --noEmit --skipLibCheck                     # types
```

Baseline esperado: zero new failures vs upstream main. ModelAgentManager flake pré-existente não conta.

---

## Flakes conhecidos do upstream

- `tests/unit/ModelAgentManager.test.ts:242` — falha em `origin/main` puro (commit `ffc55f30`). Excluir do smoke até upstream fixar.

---

## Áreas quentes de conflito em sync

- `src/agents/toolManager/services/ToolCliNormalizer.ts` — CLI parser (área quente histórica)
- `src/agents/toolManager/services/ToolBatchExecutionService.ts` — batch logic
- `src/agents/contentManager/tools/{replace,write}.ts` — content guards (#182/#185/#186)
- `src/agents/memoryManager/services/{MemoryService,WorkspaceDataFetcher}.ts` — workspace state tools (refactorado em PR #191 v5.8.7)
- `src/services/workspace/*` — workspace state services (refactor PR #191 v5.8.7 + watcher PR #193 v5.8.8)
- `src/services/helpers/DualBackendExecutor.ts` — `withReadableBackend` / `resolveReadableAdapter` (gating de reads; #190 fix em PR #197 v5.8.8 mudou `waitForQueryReady` para event-based)
- `src/utils/connectorContent.ts` — auto-gerado (sempre tomar origin + rebuild)

---

## Procedure de sync

Automação via `.github/workflows/upstream-sync.yml` (semanal domingo 02:00 UTC):
1. Fetch `origin`
2. Se drift: tentar merge em branch `sync/upstream-<date>`
3. Smoke test
4. PR no fork (clean) ou issue no fork (conflict/regression)
5. Refresh `STATUS.md` em todo run

Manual (quando necessário): procedure detalhada em [[NexusAdequacao-INI]] _index, log de sessões.
