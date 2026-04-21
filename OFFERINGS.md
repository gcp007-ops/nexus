# OFFERINGS.md

Manifest vivo dos refinamentos locais aguardando decisão upstream. Uma linha por refinamento, atualizado quando o estado muda.

Propósito: quando `ProfSynapse` convidar PR para uma issue, o bundle de commits a oferecer é trivialmente computável via `git log --grep 'Ref: #N'` — sem reler logs ou reconstruir história.

**Source of truth de tracking amplo** (issues abertas, ciclos, decisões): [[NexusAdequacao-INI]] no vault ThinkBox.

---

## Active offerings

*(vazio — sem refinamentos locais em jornada upstream)*

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

- **2026-04-20** — Manifest criado com bundle heredoc Layer 1 contra #166. Mesmo dia: retirado após evidência empírica (testes com material grande real) mostrar que heredoc preprocessor tinha custo recorrente não-antecipado. Alinhamento com maintainer's "Layer 2 alone or nothing".
