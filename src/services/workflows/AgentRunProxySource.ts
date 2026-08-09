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
const socket = net.createConnection(socketPath);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function fail(message) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  process.stderr.write(message + '\n');
  input.close();
  process.stdin.pause();
  socket.destroy();
}

socket.on('data', chunk => {
  if (!failed) process.stdout.write(chunk);
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
  }

  socket.write(JSON.stringify(request) + '\n');
});

input.on('close', () => {
  if (!failed) socket.end();
});
`;
}
