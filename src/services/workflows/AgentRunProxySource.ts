/**
 * Build the source for the short-lived stdio-to-Nexus proxy used by supervised
 * agent runs. Secrets are supplied only through the child environment and are
 * never interpolated into the generated program or its diagnostics.
 */
export function buildAgentRunProxySource(): string {
  return String.raw`
'use strict';

const net = require('node:net');
const readline = require('node:readline');

const socketPath = process.env.NEXUS_MCP_SOCKET_PATH;
const capabilityToken = process.env.NEXUS_AGENT_RUN_TOKEN;

if (!socketPath || !capabilityToken) {
  process.stderr.write('Agent run proxy configuration is incomplete\n');
  process.exit(1);
}

let failed = false;
let responseBuffer = '';
const restrictedListRequestIds = new Set();
const socket = net.createConnection(socketPath);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const restrictedDescriptions = {
  toolManager_getTools: 'Discover commands allowed by the vault-readonly capability profile.',
  toolManager_useTools: 'Execute only commands returned by vault-readonly discovery.'
};

function fail(message) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  process.stderr.write(message + '\n');
  input.close();
  process.stdin.pause();
  socket.destroy();
}

function stripInstructionText(value) {
  if (Array.isArray(value)) return value.map(stripInstructionText);
  if (!value || typeof value !== 'object') return value;

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'description' && key !== 'examples') {
      sanitized[key] = stripInstructionText(entry);
    }
  }
  return sanitized;
}

function sanitizeToolsListResponse(response) {
  if (response.error) {
    return response;
  }
  if (!response.result || !Array.isArray(response.result.tools)) {
    throw new Error('invalid tools/list result');
  }

  const toolsByName = new Map(response.result.tools.map(tool => [tool && tool.name, tool]));
  const tools = Object.keys(restrictedDescriptions).map(name => {
    const source = toolsByName.get(name);
    if (!source || typeof source !== 'object') {
      throw new Error('missing canonical read-only tool');
    }
    return {
      name,
      description: restrictedDescriptions[name],
      inputSchema: stripInstructionText(source.inputSchema || { type: 'object' })
    };
  });

  return {
    ...response,
    result: { tools }
  };
}

function forwardResponseLine(line) {
  if (failed || line.length === 0) return;

  let response;
  try {
    response = JSON.parse(line);
  } catch {
    fail('Agent run proxy received invalid JSON from Nexus');
    return;
  }

  if (restrictedListRequestIds.delete(response.id)) {
    try {
      process.stdout.write(JSON.stringify(sanitizeToolsListResponse(response)) + '\n');
    } catch {
      fail('Agent run proxy received an invalid tools/list catalog');
    }
    return;
  }

  process.stdout.write(line + '\n');
}

socket.setEncoding('utf8');
socket.on('data', chunk => {
  if (failed) return;
  responseBuffer += chunk;
  let newline = responseBuffer.indexOf('\n');
  while (newline >= 0) {
    const line = responseBuffer.slice(0, newline);
    responseBuffer = responseBuffer.slice(newline + 1);
    forwardResponseLine(line);
    newline = responseBuffer.indexOf('\n');
  }
});
socket.on('end', () => {
  if (!failed && responseBuffer.length > 0) {
    fail('Agent run proxy received an incomplete JSON response from Nexus');
  }
});
socket.on('error', () => fail('Agent run proxy connection failed'));

input.on('line', line => {
  if (failed) return;
  if (line.length === 0) {
    fail('Agent run proxy received invalid JSON');
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail('Agent run proxy received invalid JSON');
    return;
  }

  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('Agent run proxy received an invalid JSON-RPC message');
    return;
  }

  if (request.method === 'tools/call') {
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
      request.params = {};
    }
    if (!request.params.arguments || typeof request.params.arguments !== 'object' || Array.isArray(request.params.arguments)) {
      request.params.arguments = {};
    }
    request.params.arguments._agentCapabilityToken = capabilityToken;
  } else if (request.method === 'tools/list' && request.id !== undefined) {
    restrictedListRequestIds.add(request.id);
  }

  socket.write(JSON.stringify(request) + '\n');
});

input.on('close', () => {
  if (!failed) socket.end();
});
`;
}
