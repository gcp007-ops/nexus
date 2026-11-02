# FORK-DELTA.md

Ponteiro técnico mínimo do fork `gcp007-ops/nexus` (upstream: `ProfSynapse/nexus`). Vive junto do código para quem abre o repo saber o estado sem precisar puxar a vault.

**Source of truth de tracking amplo** (issues, decisões, política, história de ciclos): vault ThinkBox, `Producao/ThinkBox/Iniciativas/NexusAdequacao-INI/_index.md` + task guarda-chuva no taskManager (projectId `0c3c2fbb-9c3e-48ee-ad82-7342adc54aed`, workspace Desenvolvedor).

---

## Estado: zero divergência funcional (paridade upstream `5.16.3` / `aa6d8b82`)

Base funcional: `origin/main` em `aa6d8b82` (`5.16.3`, 2026-08-10). O fork preserva somente os artefatos próprios de governança — este arquivo, [OFFERINGS.md](./OFFERINGS.md) e [.github/workflows/upstream-sync.yml](./.github/workflows/upstream-sync.yml) — sem alteração funcional sobre o upstream.

**Sync de 2026-08-10 incorporou 11 commits upstream por merge não destrutivo.** O fork avançou de `fb7c74b7` (pós-5.16.1) para `aa6d8b82` (5.16.3), preservando a história e os três arquivos fork-only. Nesse intervalo, o refinamento local #309 foi absorvido upstream por #312–#315 e saiu de *Active offerings*; ver History em [OFFERINGS.md](./OFFERINGS.md).

**Sync de 2026-08-06 fechou um gap de 169 commits.** O fork estava parado em `4df1300a` (paridade v5.8.8, 2026-04-29) por três meses. O reset foi para `origin/main` com restauração dos três arquivos fork-only; nenhum cherry-pick funcional foi necessário. Backup do estado anterior: `backup/pre-5161-sync-2026-08-06`.

**Consequência do gap, verificada e registrada:** durante a defasagem, dois refinamentos locais que ainda eram rastreados como patches pendentes já haviam sido absorvidos upstream sem que o fork soubesse — ver History em [OFFERINGS.md](./OFFERINGS.md). Fork parado não é neutro: ele faz um patch absorvido continuar parecendo pendente.

**Nota sobre leitura de paridade.** Conferir versão do upstream por `git tag --sort=-creatordate`, **não** por `--sort=-v:refname`: a ordenação lexical de refname devolve `5.9.7` acima de `5.16.1` e produz uma leitura de defasagem que não existe. Erro cometido e corrigido em 2026-08-05.

**Meta/infra:** este arquivo + [OFFERINGS.md](./OFFERINGS.md) + [.github/workflows/upstream-sync.yml](./.github/workflows/upstream-sync.yml).

---

## Política de contribuição

**Corrigir, testar, e só então reportar.** O ciclo é: diagnosticar no fonte → corrigir no fork → testes (TDD, com RED verificado) → suíte completa → build → deploy sobre a versão instalada → smokes ao vivo → **então** abrir a issue, já com commit, diff, cobertura e o antes/depois.

**Issue-first** qualifica a *forma do reporte*, não a ordem: reportamos por **issue no upstream**, não por PR proativo (lição PR #161 → issue #162, 2026-04-18). O maintainer cherry-picka verbatim do nosso fork ou reescreve quando quer absorver.

**Exceção:** PR para upstream **só se convidado explicitamente** (ex: #166 "Layer 2 alone if we decide to adopt"; #182 PR #183 sob autorização explícita após smokes). Nesses casos, [OFFERINGS.md](./OFFERINGS.md) tem o bundle pronto.

**Deploy para smoke usa base `match-installed-version`.** Construir da tag instalada + o commit, não de `origin/main`, para que o runtime difira do stock apenas pela mudança sob teste. Branch separada quando `origin/main` já andou além da tag.

---

## Commit discipline

Quando surgir refinamento local ligado a issue upstream, usar trailer `Ref: #issue` no body:

```
fix(toolmanager): heredoc named premature close

[body explicando causa/fix]

Ref: ProfSynapse/nexus#166
```

Isto torna `git log --grep 'Ref: #166'` a lista canônica dos commits tocando aquela issue. Quando maintainer convidar PR, bundle é computável em 1 comando (ver OFFERINGS.md).
