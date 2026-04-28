# OFFERINGS.md

Manifest vivo dos refinamentos locais aguardando decisão upstream. Uma linha por refinamento, atualizado quando o estado muda.

Propósito: quando `ProfSynapse` convidar PR para uma issue, o bundle de commits a oferecer é trivialmente computável via `git log --grep 'Ref: #N'` — sem reler logs ou reconstruir história.

**Source of truth de tracking amplo** (issues abertas, ciclos, decisões): [[NexusAdequacao-INI]] no vault ThinkBox.

---

## Active offerings

_None — fork está em paridade funcional com upstream `5.8.6`. Defects ContentManager conhecidos: nenhum._

---

## History

- **2026-04-28** — v5.8.6 absorbeu #185 (`WriteTool` YAML frontmatter validation guard) e #186 (`ContentReplaceTool` NFKC compatibility tolerance) num único commit upstream `97101be` ("Guard frontmatter writes and NFKC replace matching") por `Professor Synapse` em 2026-04-28T11:34:12Z, **autoria reescrita** (sem co-author trailer — implementação independente, não cherry-pick verbatim do nosso fork). Diff: `replace.ts` -11/+8 (NFC → NFKC em `normalizeForCompare`), `write.ts` 0/+59 (novo `validateFrontmatter` async + `formatFrontmatterError` line/col/snippet/hint), `tests/unit/ContentWriteGuard.test.ts` +188, `tests/unit/ReplaceTool.test.ts` +110. Bump v5.8.6 em commit `de49d797`. Branches-offering locais (`fix/content-write-yaml-frontmatter-validation` `37d9b53b` e `fix/content-replace-nfkc-normalization` `f98f25da`) deletadas — propósito esgotado. Smokes ao vivo na build oficial 5.8.6 (`main.js` md5 `3684eaf14cee341807ddfafb4d958424`) confirmaram comportamento: F7 (write rejeita YAML inválido com formato `formatFrontmatterError`) + F8 (replace casa via NFKC, bytes literais `º`/`ª` preservados). Issues #185 e #186 ainda OPEN no GitHub (mesmo padrão de #88 pós-fix); close-request comments postados upstream. Time-to-absorption: ~7h cada.
- **2026-04-25** — v5.8.5 + PR #183 (`fix/parser-replace-content-not-found-normalization`, commit `e5926a17`, base `848c39a9`) mergeado upstream em `a4d10f1` para issue #182 (`ContentReplaceTool` NFC/NFD comparator tolerance). Branch local pode ser deletada quando o operador decidir.
- **2026-04-25** — v5.8.5 absorbeu #179 (`\X` unknown-escape consume backslash, commits `1d308cbf` + `75f18123`) e #181 (`splitTopLevelSegments` whitespace-gated comma, commit `68439360`) — incorporados nas commit messages do upstream com mesma semântica do nosso fix. Branches `fix/parser-backtick-unknown-escape` e `fix/parser-split-top-level-segments-quotes` arquivadas como referência histórica; o local deploy passa a rodar v5.8.5 puro + #182 stacked em cima. Maintainer pediu retest pós-update; smokes ao vivo do operador confirmam absorção. Time-to-absorption: #179 = 24h, #181 = 24h.
- **2026-04-20** — Manifest criado com bundle heredoc Layer 1 contra #166. Mesmo dia: retirado após evidência empírica (testes com material grande real) mostrar que heredoc preprocessor tinha custo recorrente não-antecipado. Alinhamento com maintainer's "Layer 2 alone or nothing".
