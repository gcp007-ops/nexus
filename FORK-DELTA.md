# FORK-DELTA.md

Ponteiro técnico mínimo do fork `gcp007-ops/nexus` (upstream: `ProfSynapse/nexus`). Vive junto do código para quem abre o repo saber o estado sem precisar puxar a vault.

**Source of truth de tracking amplo** (issues, decisões, política, história de ciclos): vault ThinkBox, `Producao/ThinkBox/Iniciativas/NexusAdequacao-INI/_index.md` + task guarda-chuva no taskManager (projectId `0c3c2fbb-9c3e-48ee-ad82-7342adc54aed`, workspace Desenvolvedor).

---

## Estado: zero divergência funcional

Desde 2026-04-20 (ciclo 5.8.2), o fork roda **puro upstream** em código. Único delta vs `origin/main` é este arquivo + [OFFERINGS.md](./OFFERINGS.md) + [.github/workflows/upstream-sync.yml](./.github/workflows/upstream-sync.yml) — tudo meta/infra, nada funcional.

Próximo sync upstream é fast-forward trivial esperado.

---

## Política de contribuição

**Issue-first.** Reportamos frições por **issue no upstream**; maintainer (`ProfSynapse`) cherry-picka verbatim do nosso fork quando quer absorver. Não abrimos PRs proativos (lição PR #161 → issue #162, 2026-04-18). Ver histórico em [[NexusAdequacao-INI]].

**Exceção:** PR para upstream **só se convidado explicitamente** (ex: #166 "Layer 2 alone if we decide to adopt"). Nesses casos, [OFFERINGS.md](./OFFERINGS.md) tem o bundle pronto.

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

Merges de upstream historicamente batem aqui quando havia divergência local. Com zero divergência funcional atual, expectativa é zero conflito em syncs futuros. Se conflitar, investigar se surgiu delta acidental:

- `src/agents/toolManager/services/ToolCliNormalizer.ts` — CLI parser (área quente histórica do nosso heredoc removido)
- `src/agents/toolManager/services/ToolBatchExecutionService.ts` — batch logic
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
