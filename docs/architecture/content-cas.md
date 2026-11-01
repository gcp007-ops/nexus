# Escrita condicional de conteúdo

`content cas` altera uma nota Markdown existente somente se o texto completo
observado ainda corresponde à precondição. Recebe `path`, `mutationId`,
`expectedHash`, `expectedContent` e `content`. Os conteúdos não são normalizados;
`expectedHash` é SHA-256 dos bytes UTF-8 de `expectedContent`.

A comparação ocorre dentro do callback síncrono de `Vault.process`, através de
`VaultOperations.processNote`, com `VaultPath` confinado e guarda de identidade
para arquivo movido. O hash de confirmação usa `Vault.readBinary`: a leitura
textual `Vault.read` remove BOM no aplicativo real. Notas inexistentes não são
criadas; payload vazio ou acima do limite de 2 MiB é recusado pela ferramenta.

## Operação e recuperação

A identidade interna deriva do workspace autenticado no runtime e de
`mutationId`. Parâmetros fornecidos pelo chamador não substituem a identidade
recebida do executor. O repositório existente de operações grava o evento
JSONL antes do efeito e o recibo terminal depois do readback. Não há schema,
cache autoral ou raiz de armazenamento paralelos.

O identificador deve ser mantido para o mesmo comando, sem mudar caminho ou
hashes. Operação já iniciada nunca dispara outra escrita automaticamente.
Conteúdo igual ao anterior pode ser uma restauração posterior ao efeito e não
comprova que o efeito deixou de ocorrer.

`content cas-status <mutationId>` consulta o recibo e os bytes atuais:

| Estado | Significado |
|---|---|
| `missing` | Não existe registro desse comando no workspace. |
| `completed` | Recibo terminal e bytes atuais correspondem ao resultado. |
| `recovered` | Registro iniciado e resultado presente permitem recuperar sem escrever a nota. Não atribui autoria causal. |
| `indeterminate` | Registro iniciado com bytes anteriores; exige decisão, não retry automático. |
| `failed` | Tentativa recusada antes de aceitar a mudança. |

Um terceiro conteúdo ou recibo inconsistente gera `cas_conflict`; não se
substitui a edição externa. Sem armazenamento de recibos pronto, a operação é
recusada antes da mutação. Repetição de operação concluída verifica os bytes
atuais e conserva o desfecho original (`applied` ou `recovered`).

A ferramenta é um transporte genérico. O serviço consumidor deve autenticar
quem pode comandar a alteração, vincular caso e versão e persistir sua decisão.
No FluxoFacil, essa função pertence ao gateway AN; os recibos do Nexus não
constituem aprovação jurídica. Edição direta no Obsidian continua possível.

## Fronteiras da prova

A atomicidade é a fornecida pelo Vault API na instância que atende a chamada;
não há transação distribuída entre hosts de sincronização. Os testes de unidade
provam a lógica do consumidor da API; a qualificação real exige aplicativo e
vault isolados, incluindo bytes, concorrência e reconstrução de cache.

O ensaio da CicloProducaoPeca-INI exerceu o aplicativo real em perfil e vault de
QA próprios: BOM/CRLF, falha após efeito com recuperação sem nova escrita,
restauração externa recusada, dois clientes com um vencedor, cache removido e
reconstituído de JSONL e gateway SW com ator não autorizado recusado. A
instalação produtiva é gate separado. Evidência e versão do artefato vivem no
relatório da iniciativa, não são inferidas da versão do manifest.
