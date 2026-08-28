// Faz o Node entrar no MESMO ramo de ambiente que o Electron renderer usa.
// O build do sqlite3.wasm e -sENVIRONMENT=web,worker: ele aborta se detectar Node.
// A deteccao e exatamente:
//   ENVIRONMENT_IS_WEB  = typeof window == 'object'
//   ENVIRONMENT_IS_NODE = typeof process == 'object' && process.versions?.node
//                         && process.type != 'renderer'
// O renderer do Electron satisfaz as duas condicoes que queremos aqui (window
// existe, process.type === 'renderer'), e e por isso que o Nexus carrega o
// modulo la sem patch. Este shim reproduz esse par — nao emula DOM.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (process.type !== 'renderer') process.type = 'renderer';
