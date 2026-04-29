# FORK-DELTA.md

Ponteiro técnico mínimo do fork `gcp007-ops/nexus` (upstream: `ProfSynapse/nexus`). Vive junto do código para quem abre o repo saber o estado sem precisar puxar a vault.

**Source of truth de tracking amplo** (issues, decisões, política, história de ciclos): vault ThinkBox, `Producao/ThinkBox/Iniciativas/NexusAdequacao-INI/_index.md` + task guarda-chuva no taskManager (projectId `0c3c2fbb-9c3e-48ee-ad82-7342adc54aed`, workspace Desenvolvedor).

---

## Estado: zero divergência funcional (paridade 5.8.7)

Base: `origin/main` em `5.8.7` (`ac5da9ee`). v5.8.7 absorbeu #185+#186 (já cobertos em v5.8.6) administrativamente e adicionou PR #191 "Fix workspace state tool flows" (commit upstream `6958856`, 47 arquivos, refactor amplo de `MemoryService.getStates` + `createState` + `loadState` + `listStates` + `WorkspaceService` + `WorkspaceStateService`).

**Sobre #190 (loadWorkspace silent empty):** investigação empírica via instrumentation file-based revelou hydration race em `withReadableBackend` (não filtros tautológicos como suposto inicialmente na Fase A). PR #191 melhorou writes mas reads continuam gateadas em `resolveReadableAdapter.isQueryReady()`. Issue permanece OPEN com comment de diagnóstico atualizado. Sem fix local oferecido — deferido para maintainer decidir abordagem (queue reads / sync legacy / surface hydration state).

**Branches deletadas neste sync:** `fix/loadworkspace-states-empty-defensive-filter` (Fase A obsoleta), `investigation/f3-v587` (instrumentation usada e descartada). Backup `backup/pre-587-sync-2026-04-28` preservado em fork.

**Zero cherry-picks funcionais.** Trinca histórica do parser CLI (#163/#165, #167, #172, #179, #181) absorvida em v5.8.5 e antes; trinca ContentManager (#182, #185, #186) absorvida em v5.8.6. Defects ContentManager remanescentes conhecidos: nenhum.

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
- `src/agents/memoryManager/services/{MemoryService,WorkspaceDataFetcher}.ts` — workspace state tools (PR #191 / #190 hydration race)
- `src/services/workspace/*` — workspace state services (PR #191)
- `src/services/helpers/DualBackendExecutor.ts` — `withReadableBackend` / `resolveReadableAdapter` (gating de reads via `isQueryReady`; ponto suspeito do #190)
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
