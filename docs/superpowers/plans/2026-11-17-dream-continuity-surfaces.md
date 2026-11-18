# Continuidade Dream — superfícies Nexus

Contrato governante: `Producao/ThinkBox/Iniciativas/Dream-INI/PLAN-Continuidade-2026-11-17.md` na vault ThinkBox, desenho A1–A3 aprovado. Implementação e cadeia técnica autorizadas pelo operador com preflight e readback.

Esta unidade substitui as construções independentes de TaskService por uma factory compartilhada no container. MCP e interface devem obter a mesma instância e as mesmas barreiras de disponibilidade. A configuração de autoridade será ligada somente após o runtime correspondente existir; esta refatoração não admite projetos nem concede capacidade.

Refatorar junto: factory e seus dois consumidores; remover imports e construção substituída. Preservar semântica de resolução de workspace e espera de hidratação. Verificação nominal: TaskService, ProjectsManagerViewTaskDetail e prova da identidade compartilhada. Sem suíte completa ou implantação nesta unidade.
