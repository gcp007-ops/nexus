# FORK-DELTA.md

Ponteiro técnico mínimo do fork `gcp007-ops/nexus` (upstream: `ProfSynapse/nexus`). Vive junto do código para quem abre o repo saber o estado sem precisar puxar a vault.

**Source of truth de tracking amplo** (issues, decisões, política, história de ciclos): vault ThinkBox, `Producao/ThinkBox/Iniciativas/NexusAdequacao-INI/_index.md` + task guarda-chuva no taskManager (projectId `0c3c2fbb-9c3e-48ee-ad82-7342adc54aed`, workspace Desenvolvedor).

---

## Estado: transporte CAS local sobre upstream `e4721ac6`

Base funcional: `ProfSynapse/nexus` em `e4721ac6`, posterior à versão 5.21.2.
A versão declarada do fork é 5.22.0. O delta funcional local acrescenta
`content cas` e `content cas-status`: precondição atômica de conteúdo no
`Vault.process`, recibo JSONL e recuperação sem repetir efeito incerto.
Contrato: [escrita condicional](docs/architecture/content-cas.md).

O histórico do fork e seus três arquivos de governança são preservados por
merge não destrutivo. Catálogos históricos conservam os bytes das respectivas
versões; a interface atual é publicada no catálogo 5.22.0.

O tracking desta mudança vive em `CicloProducaoPeca-INI` na vault ThinkBox.
Provas de publicação, instalação, backup e readback são recibos separados;
versão do manifesto ou build local não comprova instalação produtiva.

---

## Política de contribuição

**Corrigir, testar, e só então reportar.** O ciclo é: diagnosticar no fonte → corrigir no fork → testes causais (TDD, com RED verificado) e consumidores dos contratos alterados → build → deploy sobre a versão instalada → smokes ao vivo → **então** reportar com commit, diff, cobertura e o antes/depois. A qualificação é por impacto: suíte completa quando o alcance transversal não puder ser delimitado ou houver validação periódica explicitamente planejada. Publicação e mudança de SHA, sozinhas, não ampliam a seleção. Falhas conhecidas não são omitidas.

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
