# OFFERINGS.md

Manifest vivo dos refinamentos locais aguardando decisão upstream. Uma linha por refinamento, atualizado quando o estado muda.

Propósito: quando `ProfSynapse` convidar PR para uma issue, o bundle de commits a oferecer é trivialmente computável via `git log --grep 'Ref: #N'` — sem reler logs ou reconstruir história.

**Source of truth de tracking amplo** (issues abertas, ciclos, decisões): [[NexusAdequacao-INI]] no vault ThinkBox.

---

## Active offerings

Nenhum refinamento local aguarda decisão upstream neste ponto de sincronização. Issues ainda abertas e patches privados em elaboração permanecem no tracking da vault até existir implementação testada e oferta publicável.

---

## History

- **2026-08-10** — **Sync de 11 commits**, `fb7c74b7` (pós-5.16.1) → `aa6d8b82` (5.16.3), por merge não destrutivo que preservou os três arquivos fork-only. O offering **#309** foi absorvido upstream em uma sequência de quatro mudanças: #312 colocou conteúdo real acima de nome difuso; #313 colocou nota nomeada para a consulta acima de mera menção; #314 cobriu filename kebab-case contra consulta com espaços; #315 alinhou os testes de ranking ao comportamento da vault. A implementação upstream é mais ampla que o patch local; o offering saiu da lista ativa.
- **2026-08-06** — **Sync de 169 commits**, v5.8.8 → `origin/main` `fb7c74b7` (pós-5.16.1). O fork ficou três meses parado, e o custo apareceu no inventário: **duas receitas de patch ainda rastreadas como pendentes já estavam absorvidas**. `nexus-metadata-merge-state-tags` (issues #305/#306 — merge raso de metadata de task/project com `metadataMode` e `removeMetadataKeys`, mais tags atuais no boundary de leitura de state) foi absorvida upstream por **#307** `fix(tasks): merge metadata updates` e **#308** `Fix load-state returning stale tags`, ambos entre a tag 5.16.1 e `fb7c74b7`. Absorção verificada pelas próprias `verify_strings` da receita (`metadataMode`, `removeMetadataKeys` presentes no fonte de `origin/main`). Implementação **reescrita pelo maintainer**, não cherry-pick: `git cherry` marca nossos `3d91228f` e `9f1b53c5` como ausentes, e o commit upstream toca 18 arquivos contra 14 dos nossos — mesmo contrato, código diferente. Branch `fix/metadata-merge-state-tags` e a receita foram aposentadas. Consequência a registrar: a correção está em `origin/main` mas **não** na 5.16.1 instalada, então existe janela em que o defeito segue vivo sem patch nem release — ela fecha sozinha no próximo bump.
- **2026-04-29** — v5.8.8 absorbeu **#190** (loadWorkspace silent empty / hydration race) via PR #197 "fix(storage): event-based waitForQueryReady + await before legacy fallback" (commit upstream `ffb20171`, merge `7123ebe8`, bump v5.8.8 `b3fc4340`). `HybridStorageAdapter.waitForQueryReady` passou a ser settled por phase transitions (não polling), com timeout 60s demoted a safety net; `withReadableBackend` aguarda hydration antes de cair no legacy. Smokes em v5.8.8 (warm + pós Cmd+P Reload, 5x `loadWorkspace` paralelas + 1x `list-states` cada): 6/6 `success: true`, 0/5 "Workspace not found", 5/5 `data.states` populated. Bonus: `data.sessions` passou a carregar chat sessions ativas. Pendência minor não-bloqueante: echo de `data.workspaceContext.workspaceId` no envelope continua ausente. Outras PRs do batch: #192, #193, #194, #195, #196. Time-to-absorption desde #190: ~24h. Backup branch: `backup/pre-588-sync-2026-04-29`.
- **2026-04-28** — v5.8.7 absorbeu #185+#186 close-requests e introduziu PR #191 "Fix workspace state tool flows" (47 arquivos, autoria reescrita). PR #191 melhorou writes mas não fechou #190; investigação local com instrumentation file-based identificou hydration race em `withReadableBackend` (`DualBackendExecutor.ts:98`). Branches `fix/loadworkspace-states-empty-defensive-filter` e `investigation/f3-v587` deletadas — Fase A era fix em ponto errado.
- **2026-04-28** — v5.8.6 absorbeu #185 (`WriteTool` YAML frontmatter validation guard) e #186 (`ContentReplaceTool` NFKC compatibility tolerance) num único commit upstream `97101be`, **autoria reescrita**. Branches-offering locais deletadas. Time-to-absorption: ~7h cada.
- **2026-04-25** — v5.8.5 + PR #183 (`fix/parser-replace-content-not-found-normalization`, commit `e5926a17`) mergeado upstream em `a4d10f1` para issue #182 (`ContentReplaceTool` NFC/NFD comparator tolerance).
- **2026-04-25** — v5.8.5 absorbeu #179 (`\X` unknown-escape consume backslash) e #181 (`splitTopLevelSegments` whitespace-gated comma) — mesma semântica do nosso fix. Branches arquivadas como referência histórica. Time-to-absorption: 24h cada.
- **2026-04-20** — Manifest criado com bundle heredoc Layer 1 contra #166. Mesmo dia: retirado após evidência empírica mostrar custo recorrente não-antecipado. Alinhamento com "Layer 2 alone or nothing" do maintainer.
