# OFFERINGS.md

Manifest vivo dos refinamentos locais aguardando decisão upstream. Uma linha por refinamento, atualizado quando o estado muda.

Propósito: quando `ProfSynapse` convidar PR para uma issue, o bundle de commits a oferecer é trivialmente computável via `git log --grep 'Ref: #N'` — sem reler logs ou reconstruir história.

**Source of truth de tracking amplo** (issues abertas, ciclos, decisões): [[NexusAdequacao-INI]] no vault ThinkBox.

---

## Active offerings

### `ContentReplaceTool` NFC/NFD comparator tolerance — awaiting decision on [#182](https://github.com/ProfSynapse/nexus/issues/182)

**Branch:** [`fix/parser-replace-content-not-found-normalization`](https://github.com/gcp007-ops/nexus/tree/fix/parser-replace-content-not-found-normalization) (rebased onto upstream v5.8.5)
**Commit:** `f3c38993` (or rebased equivalent on top of v5.8.5)
**Opened:** 2026-04-25

**Summary:** `ReplaceTool.execute` matched `oldContent` against the file content via strict byte equality after CRLF normalization only. Two visually identical strings differing only in Unicode normalization form (NFC vs NFD — typical for accented PT-BR text round-tripping through an NFD-decomposing pipeline layer) failed silently with `Content not found at lines X-Y or anywhere else in the note`, forcing operators to escalate to overwrite (which violates the minimum-edit rule and rewrites parts of the file the operator did not intend to touch). Fix: introduce `normalizeForCompare` that wraps `normalizeCRLF` with `.normalize('NFC')` and route both legs of the equality check (line-range exact match and sliding-window fallback) through it. The original `normalizeCRLF` helper is unchanged so the rebuild path keeps writing `newContent` verbatim and the file's untouched parts retain their original normalization form.

**Scope:** 1 new helper + 2 call-sites switched + sliding-window pre-normalization for O(N) instead of O(N*M) inner-loop normalize calls; 6 new regression cases (file-NFC/old-NFD real-world repro, file-NFD/old-NFC inverse drift, sliding-window survives drift, multi-line mixed normalization, truly-absent guard, ASCII no-op guard) + 1 fixture sanity. ReplaceTool: 33/33 (27 prior + 6 new). Full suite zero regressions on the rebased base. `tsc --noEmit` clean, `eslint .` clean, `esbuild` production clean.

**Stacking note:** branch was previously stacked over `fix/parser-split-top-level-segments-quotes` (#181) and `fix/parser-backtick-unknown-escape` (#179) for local-deploy continuity. After v5.8.5 absorbed #179 + #181 (commits `1d308cbf` / `75f18123` / `68439360`) the prior two branches are now redundant and have been parked as historical (see "History"); the #182 branch was rebased to sit directly on top of upstream `main`.

**Offer pattern:** follow #172 / #179 / #181 — reference impl ready on branch; awaiting maintainer decision on whether to cherry-pick, request PR, or decline.

Desde 2026-04-20 o fork roda puro upstream em código. Novos refinamentos locais seguirão o padrão:

1. Commit com trailer `Ref: ProfSynapse/nexus#N`
2. Entrada nova nesta seção descrevendo status (`awaiting decision on #N`, `offered via comment-XXX`, etc.)
3. Se maintainer convidar PR, usar `git log --grep 'Ref: #N'` para bundle exato
4. Se aceito: sai desta seção após sync upstream (fast-forward absorve)
5. Se declinado: move para "Withdrawn" ou "Declined → permanent local"

---

## Withdrawn

### Heredoc Layer 1 refinement bundle — withdrawn 2026-04-20

**Histórico:** Maintainer abriu #166 em 2026-04-19 como design gate referenciando nosso commit `1f8c5fab` como reference implementation. Framing explícito: "Pick at most Layer 2, defer Layer 1, or do nothing". Inclinação dele era Layer 2 (greedy fallback) alone ou nothing — rationale: Layer 1 (heredoc raw blocks) exige ensinar sintaxe nova a todos os system prompts; Layer 2 tem blast radius menor.

**Acumulamos 3 refinamentos locais** sobre o `1f8c5fab` original:
- Raw blocks + greedy fallback (base)
- Named heredoc multiline close + comma terminator (`Ref: #166`)
- Anon extraction before named (`Ref: #166`)

**Testes empíricos em 2026-04-20** manipulando material grande real (logs de INI, payloads 5KB+) revelaram que o heredoc preprocessor é **quote-unaware**: escaneia tool string inteiro antes do parser de quoted strings, então mencionar `<<NAME` ou `<<<` literal dentro de `--content "..."` triggera consumo indevido. Em 5.8.2 base (sem heredoc), esses padrões seriam literais intactos. Heredoc estava criando fricção até para quem **não queria** usá-lo.

**Decisão:** withdraw. Alinhar com framing do maintainer — named-flag form (`--content "..."` com `\"` / `\n` escapes) + LLM discipline cobrem perfil real de uso. Aspas internas não-escapadas (failure mode do #166) continuam como limitação, recuperável via `\"` escape ou eventualmente Layer 2 se maintainer adotar.

**Comentário pendente no #166:** retirar oferta de Layer 1, endossar "Layer 2 alone or nothing" baseado na evidência empírica, oferecer Layer 2 isolado se ele decidir adotar.

**Backup histórico:** branch `backup/pre-heredoc-removal-2026-04-20` no fork local preserva código do refinement bundle caso futuro precise reanimar.

---

## Declined → permanent local

*(vazio)*

Refinamentos que upstream decidiu explicitamente NÃO absorver e que mantemos no fork por necessidade operacional ficam aqui com motivo + commits. Continuam ativos no fork como divergência consciente.

---

## History

- **2026-04-25** — v5.8.5 absorbeu #179 (`\X` unknown-escape consume backslash, commits `1d308cbf` + `75f18123`) e #181 (`splitTopLevelSegments` whitespace-gated comma, commit `68439360`) — incorporados nas commit messages do upstream com mesma semântica do nosso fix. Branches `fix/parser-backtick-unknown-escape` e `fix/parser-split-top-level-segments-quotes` arquivadas como referência histórica; o local deploy passa a rodar v5.8.5 puro + #182 stacked em cima. Maintainer pediu retest pós-update; smokes ao vivo do operador confirmam absorção. Time-to-absorption: #179 = 24h, #181 = 24h.
- **2026-04-20** — Manifest criado com bundle heredoc Layer 1 contra #166. Mesmo dia: retirado após evidência empírica (testes com material grande real) mostrar que heredoc preprocessor tinha custo recorrente não-antecipado. Alinhamento com maintainer's "Layer 2 alone or nothing".
