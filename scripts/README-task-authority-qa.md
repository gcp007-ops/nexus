# Ensaio isolado da autoridade

`verify-task-authority.mjs` tem modos `authority`, `client` e `reconcile`.
Todos usam o mesmo `--run-id` e diretório externo de evidências. Os modos no
aplicativo exigem `--vault`, `--expected-path` e `--require-obsidian`, conferem
nome e caminho no aplicativo e recusam vault sem `.task-authority-qa.json`
com protocolo `task-authority-disposable-qa/v1`. Use nomes contendo
`authority-qa-`. Um relatório ou intenção existente impede recriar a fixture.

1. Execute `--mode authority --run-id <id> --output-root <dir>` com os argumentos
   da vault isolada. O relatório contém a fixture e prova WASM, interface, CLI,
   recarga e reconstrução. Ao terminar, a autoridade está suspensa.
2. No alvo isolado, provisione certificado válido e credenciais individuais pelo
   serviço `taskAuthorityProvisioning`; configure o transporte HTTPS da fixture.
   Conserve as mesmas funções de seleção e recusa de efeitos externos. Permita ao
   participante somente `interactiveMutation` no projeto `fixture.p`. Nunca
   altere a confiança TLS nem grave valores de segredo nos relatórios.
3. Crie arquivo público fechado com `protocol: task-authority-qa-participant/v1`,
   `run_id`, `vault_scope`, `authority_id`, `project_id`, `issuer_id`,
   `service_origin` HTTPS e `credential_secret_id` local já provisionado. Escopo
   e autoridade devem ser `qa-<id>` e `qa-authority-<id>`.
4. Na workstation participante, execute `--mode client --participant-file <json>`
   com os argumentos da vault e execução. A intenção é salva antes da mutação.
   Resultado confirmado é conferido após recarga; resposta desconhecida interrompe
   a escrita. `--phase recover` consulta somente o recibo e conserva `not_found`
   como ausência observada, sem reenviar. Não apague a intenção para tentar de novo.
5. Transfira o relatório público do cliente ao diretório da autoridade e execute
   `--mode authority --phase readback --participant-file <json>` com a fixture
   ainda vinculada à instância real. Esse passo lê o recibo canônico, a fonte
   completa e a proveniência da prioridade; não escreve tarefas.
6. Execute `--mode reconcile --run-id <id> --output-root <dir>`. Exige os três
   relatórios, hosts diferentes e correspondência de identidades, recibos e
   readback; grava também os hashes dos arquivos de entrada.
7. Suspenda os clientes e listener, confira portas fechadas e retire somente as
   credenciais sintéticas. Conserve qualquer intenção incerta em custódia.

Esses modos não qualificam execução técnica, CAS do host ou fechamento
interrompido. Essas fronteiras exigem os cenários integrados próprios. Resultados
históricos de scripts de investigação não são rebatizados como execução deste
driver. Execute a versão final no ambiente declarado antes de alegar sua prova.
