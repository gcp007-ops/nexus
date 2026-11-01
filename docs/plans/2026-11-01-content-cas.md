# Transporte CAS para CicloProducaoPeca-INI

Autorização: operador determinou preparar transporte CAS no Nexus em branch
separada. Base `origin/main` 52c22b6e, compatível com a versão instalada 5.21.2.
Nenhuma instalação produtiva faz parte desta preparação.

## Contrato

Adicionar `content cas` e `content cas-status`, mantendo os comandos anteriores.
CAS exige arquivo Markdown existente, bytes esperados completos, SHA-256 desses
bytes, novos bytes e mutation_id estável. Validar hash fora do callback e comparar
texto exatamente dentro de `Vault.process` (callback síncrono); não normalizar
CRLF, Unicode ou BOM. Dado concorrente divergente impede a escrita.

Preparar recibo JSONL antes do efeito pelo ToolOperationRepository existente,
sem novo schema ou raiz de armazenamento. Reutilizar operação iniciada/completa,
com assinatura dos hashes e caminho; recibos não duplicam conteúdo da AN.
Após falha entre escrita e recibo terminal, consultar registro iniciado e bytes
atuais: resultado presente permite recuperação explícita, sem atribuir autoria
causal que o recibo não demonstra; divergência exige intervenção. Conteúdo igual ao anterior não prova ausência do efeito: operação já iniciada
sem resultado confirmável fica indeterminada e não é reexecutada automaticamente.
Sem journal pronto, recusar antes de modificar a nota. `cas-status` não escreve na nota.

Autoridade jurídica e vínculo de caso continuam no serviço SW. O transporte não
transforma chamada genérica em aprovação de sócio. Atomicidade é a do Vault API
na instância Obsidian; sincronização entre hosts não é transação distribuída.
A prova em app real isolado deve cobrir o comportamento e a releitura.

## Passos e aceite

1. Teste causal RED→GREEN de precondição durante o callback, recibo antes do
   efeito, dois donos, queda após efeito, replay, edição externa, path traversal,
   entrada inválida, workspace e storage indisponível.
2. Serviço CAS e duas ferramentas; registro/política/injeção de dependência.
3. Catálogos gerados, typecheck/lint/build e consumidores nominais de registro,
   contexto, CLI, políticas e operações. A instrução superior de qualificação por
   impacto limita a seleção, em lugar da suíte ampla prescrita genericamente
   pela skill de testes; não há alteração transversal de contrato existente.
4. Adaptador SW e testes do limite real por comandos CLI; continuar bloqueado
   quando a instalação não expuser a capacidade.
5. Revisão independente focal do transporte, uma passada; correções reproduzíveis
   RED→GREEN. Candidato pronto para gate de instalação, sem alegar validação
   produtiva ou escrita AN de caso.

## Refatoração e limpeza

Reusar repositório de operações e os eventos/applier existentes; não criar
segundo journal. Novas ferramentas são aditivas. Comandos antigos permanecem
consumidos; nenhum caminho morto removido sem prova. Temporários, fixtures e
artefatos em `/Volumes/Dados/qa-temp/nexus/ciclo-producao-peca-cas/`.

## Evidência do candidato

- Registro eager das duas ferramentas preserva o canal de identidade do runtime;
  o proxy LazyTool não encaminha essa opção. Não se alterou o proxy compartilhado.
- Revisão independente encontrou repetição indevida após restauração externa dos
  bytes antigos. Regressão RED→GREEN: claim existente sem resultado presente é
  indeterminado e não dispara nova escrita.
- Ensaio real identificou BOM removido por Vault.read. Regressão RED→GREEN e
  confirmação física passaram a usar readBinary.
- 252 testes selecionados passaram; build completo, typecheck/lint/mobile e
  catálogos passaram. Evidência fora do repo em
  `/Volumes/Dados/qa-temp/FluxoFacil/ciclo-producao-peca/`.
- Aplicativo real em perfil/vault exclusivos de QA qualificou recuperação após
  falha e reload (mtime da nota inalterado), dois clientes concorrentes,
  restauração externa recusada e recibo após remoção/rebuild do cache JSONL.
- Gateway SW→CLI→Nexus→arquivo→recibo→DB foi exercitado com tarefa e AN fictícias;
  executor foi recusado e replay não alterou mtime nem duplicou decisão local.
  Corpus jurídico, UI e aceitação produtiva não foram inferidos desse ensaio.
- Nenhum código foi substituído na instalação produtiva. Hash do main.js
  produtivo permaneceu fce71e72094110906a772e43334e420fea894e04c9c53a57f56a2405ec79af27.
