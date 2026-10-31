# Diagnóstico histórico de rastros do Nexus

Ferramenta local de leitura, compatível com Node.js 18 ou superior, sem instalação de dependências. Não inicializa o plugin, não abre o SQLite e não altera registros. Foi desenvolvida no fork 5.16.3; não exige atualização para 5.21.2.

## Preparar a entrada

1. Identifique o armazenamento efetivo nas configurações do Nexus. Não suponha que esteja em `Nexus/data`: instalações antigas, raízes configuradas e armazenamento no diretório do plugin podem usar outros caminhos.
2. Encerre o Obsidian e espere a sincronização terminar antes de copiar. Prefira snapshot consistente e mantenha uma cópia original separada. Copie o diretório de dados que contém `workspaces/`; para comparação opcional, copie também os arquivos atuais da vault.
3. Use somente uma geração de armazenamento por execução. Não junte raízes atuais e antigas: isso pode duplicar históricos. Execute cada raiz separadamente e identifique a proveniência fora do relatório.
4. Salve o relatório fora do diretório de entrada. A ferramenta escreve somente na saída padrão; redirecionamento é uma ação do shell e pode sobrescrever um arquivo escolhido incorretamente.

## Executar

A partir da raiz deste repositório, ajuste os caminhos para as suas cópias:

```powershell
node scripts/audit-trace-history.mjs --help
node --test scripts/audit-trace-history.test.mjs
node scripts/audit-trace-history.mjs --data-root 'D:/NexusAudit/copia/data' > 'D:/NexusAudit/relatorio.json'
```

Para verificar se determinados corpos de escrita são idênticos aos arquivos atuais:

```powershell
node scripts/audit-trace-history.mjs --data-root 'D:/NexusAudit/copia/data' --vault-root 'D:/NexusAudit/copia-vault' > 'D:/NexusAudit/relatorio-comparado.json'
```

Sem `--vault-root`, a ausência de comparação é explícita. No PowerShell antigo, o redirecionamento pode produzir UTF-16; use PowerShell 7 ou converta a codificação ao consumir o JSON. Nunca redirecione a saída para um shard ou uma nota da cópia.

## O que a análise permite concluir

O volume físico inclui as ocorrências dos eventos presentes nos arquivos, inclusive cópias repetidas. As contagens lógicas descontam apenas duplicatas demonstradas; versões divergentes de uma mesma identidade são conflitos, não duplicatas descartáveis. Os agrupamentos seguem os streams de armazenamento, sem fundir nomes e IDs de workspace. A issue #214 já demonstrou que essas identidades podem ter sido fragmentadas.

O limiar de seleção é **registro JSONL maior que 64 KiB**, em bytes UTF-8, sem CR/LF. Não é o tamanho de caracteres nem o tamanho isolado de `metadataJson`. Os metadados são medidos separadamente em sua representação interna e como string escapada no evento externo.

A estimativa de redução simula metadados que ocupem exatamente 16 KiB internos, com diferentes custos de escape. Não é um intervalo garantido para todo resultado menor ou igual a 16 KiB. Ela não executa o compactador de 5.21.2 nem promete o tamanho final de uma migração. JSON dentro de JSON exige escapar aspas e barras; portanto o relatório distingue bytes internos e bytes serializados. Não some economias de duplicatas e compactação: podem representar os mesmos bytes. Arquivos de arquivo morto, backups, cache SQLite, tarefas e conversações não entram numa promessa de economia líquida.

A evidência de redundância é deliberadamente conservadora:

- Corpo de escrita idêntico ao arquivo atual: recuperável naquele snapshot; não significa que todos os metadados do rastro sejam redundantes.
- Corpo repetido: há mais de uma ocorrência, mas pelo menos uma cópia íntegra precisa continuar preservada.
- Arquivo alterado, ausente, inacessível ou caminho inseguro: exige preservação adicional.
- Payloads de estado, resultados legados e formatos não reconhecidos: presumidos potencialmente únicos.

A comparação reconhece somente formas de escrita cuja interpretação é inequívoca. Não executa comandos extraídos dos rastros, não resolve referências via rede e não tenta adivinhar escapes ou sintaxes não suportadas. O resultado agregado não mostra corpos, comandos, nomes dos arquivos de destino ou prévias. Os nomes de streams podem identificar workspaces; revise essa informação antes de compartilhar o relatório.

## Cuidados para uma migração futura

Uma migração só deve ser considerada após uma medição completa, estável e sem conflitos não resolvidos. Se a análise for parcial, seu volume representa apenas o que foi coberto.

Antes de qualquer reescrita futura:

1. Arquivar os bytes originais dos shards e todos os payloads sem recuperação comprovada; verificar hashes e testar restauração. Uma cópia atual de nota não substitui a preservação de versões antigas.
2. Preservar identidade, ordem, timestamps e campos externos aos metadados. Não renomear shards nem invalidar cursores de replay.
3. Resolver duplicatas divergentes e avaliar dispositivos offline, versões diferentes do plugin, shards ativos e risco de perda de anexações durante a sincronização.
4. Testar replay e equivalência em cópias, incluindo estados e conversações; planejar atualização do cache sem reconstrução indiscriminada ou nova geração de embeddings.
5. Medir separadamente redução no armazenamento sincronizado, custo dos arquivos preservados e eventual recuperação do SQLite. Definir retenção e localização do arquivo antes de prometer economia líquida.

## Arquitetura e fontes

No fork, `TraceRepository.addTrace` grava `trace_added` em `workspaces/ws_<workspaceId>.jsonl`, com metadados serializados em `data.metadataJson`. `VaultEventStore` e `ShardedJsonlStreamStore` materializam streams em diretórios e shards. `WorkspaceMigrator` importa os rastros legados. `WorkspaceEventApplier` projeta o evento em SQLite.

Fontes verificadas em 31/10/2026:

- [Release 5.21.2](https://github.com/ProfSynapse/nexus/releases/tag/5.21.2).
- [Plano de compactação](https://github.com/ProfSynapse/nexus/blob/main/docs/plans/trace-payload-compaction-plan.md): a migração histórica exige preservação dos originais.
- [TraceRepository upstream](https://github.com/ProfSynapse/nexus/blob/main/src/database/repositories/TraceRepository.ts): compactação no caminho de novos registros.
- [Issue #214](https://github.com/ProfSynapse/nexus/issues/214): os aproximadamente 119 MB, 9.933 rastros e 91% são números históricos de maio, não uma medição atual do ThinkBox.

Nenhum dado real do ThinkBox foi analisado durante a implementação. A decisão sobre migrar seu histórico depende da execução posterior desta ferramenta sobre uma cópia consistente.


## Campos principais do JSON

| Campo | Interpretação |
|---|---|
| `discovery` | Arquivos reconhecidos, ignorados, bytes inventariados e entradas inseguras no diretório `workspaces/`. |
| `streams[].workspace` / `layout` | Identificador físico do stream e disposição legada ou em shards; não é uma resolução de aliases. |
| `physical.rawBytes` | Bytes físicos dos arquivos reconhecidos; inclui delimitadores de linha. |
| `physical.traceRawLineBytes` / `traceRecords` | Bytes sem delimitadores e quantidade de ocorrências de rastros. |
| `physical.traceOversizedRecords` | Rastros cuja linha ultrapassa 65.536 bytes. |
| `unique` / `identity` | Métricas descontando duplicatas comprovadas e sinalização de identidades divergentes ou não verificadas. |
| `metadataUtf8Bytes` / `metadataEncodedBytes` | Bytes da string interna de metadados e da representação escapada no evento. |
| `logicalMetadataExcessBytes` | Soma do excesso interno acima de 16 KiB; sobrepõe o cenário de redução, não deve ser somada a ele. |
| `metadataScenarioCandidateRecords` | Rastros acima de 64 KiB com metadados válidos acima de 16 KiB. |
| `metadataScenarioLowerBytes` / `metadataScenarioUpperBytes` | Redução do cenário de metadados de exatamente 16 KiB, variando o custo de escape entre representações; não corresponde à execução do compactador. |
| `preservation` | Evidência de igualdade atual, diferenças, ausências, caminhos inseguros, corpos repetidos e ocorrências sem verificação. |
| `sourceUnchanged` | Comparação de inventário e hashes internos durante a execução; não certifica a consistência anterior da cópia nem substitui snapshot atômico. |
| `partial` / `errors` | Lacunas de cobertura e códigos fixos de erro, sem conteúdo sensível de exceções. |

Os campos de métricas também aparecem em `totals`. Campos físicos de arquivo não têm significado de volume em `unique`. `distinctBodiesRequiringFirstCopy` conta todos os corpos distintos reconhecidos, inclusive os que coincidem com notas atuais: a ferramenta conserva a exigência de preservar ao menos uma cópia. Isso não é uma contagem de conteúdo comprovadamente único.

Limites operacionais: linhas acima de 128 MiB são contabilizadas como não analisadas; há teto de um milhão de versões de evento e hashes de corpos por stream. O relatório informa cobertura parcial quando ultrapassa os limites. Arquivos não reconhecidos ficam inventariados, mas não têm seus eventos interpretados. O código de saída diferente de zero indica entrada inválida ou análise parcial; verifique também `discovery`, `identity` e `preservation` mesmo quando a saída for zero.

## Validação da entrega

Execução sintética em Windows, Node.js v24.13.0: `node --test scripts/audit-trace-history.test.mjs`, 16 testes aprovados, nenhum ignorado. A suíte cobre layouts legados e shards de conflito, limite UTF-8 de 64 KiB, contagem de escapes, duplicatas e identidades divergentes, comparação de conteúdo, confinamento de caminhos, JSON/UTF-8 inválidos, limite de linha, contrato da CLI e preservação dos bytes de entrada. O teste de junction precisa de um ambiente Windows que permita criar esse tipo de atalho nas pastas temporárias.

`node --check scripts/audit-trace-history.mjs` e a ajuda da CLI também foram verificados. O build do plugin e sua suíte integral não foram executados: estes arquivos são scripts independentes, não importados pelo plugin, e `eslint.config.mjs` exclui `scripts/` e `docs/`. A compatibilidade mínima declarada é Node.js 18; esta entrega foi exercitada em Node.js 24.
