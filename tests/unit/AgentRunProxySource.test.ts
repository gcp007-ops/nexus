import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolManagerAgent } from '../../src/agents/toolManager/toolManager';
import { ToolListStrategy } from '../../src/handlers/strategies/ToolListStrategy';
import { buildAgentRunProxySource } from '../../src/services/workflows/AgentRunProxySource';

interface ProxyExerciseResult {
  forwarded: Record<string, unknown>[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function exerciseProxy(
  lines: string[],
  token: string,
  responseForRequest?: (request: Record<string, unknown>) => Record<string, unknown>
): Promise<ProxyExerciseResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-proxy-'));
  const socketPath = path.join(tempDir, 'proxy.sock');
  const forwarded: Record<string, unknown>[] = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          forwarded.push(JSON.parse(line) as Record<string, unknown>);
          const request = forwarded[forwarded.length - 1];
          const response = responseForRequest?.(request) ?? {
            jsonrpc: '2.0',
            id: request.id,
            result: { accepted: true }
          };
          socket.write(`${JSON.stringify(response)}\n`);
        }
        newline = buffer.indexOf('\n');
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    const child = spawn(process.execPath, ['-e', buildAgentRunProxySource()], {
      env: {
        ...process.env,
        NEXUS_MCP_SOCKET_PATH: socketPath,
        NEXUS_AGENT_RUN_TOKEN: token
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    for (const line of lines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    return { forwarded, stdout, stderr, exitCode };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('buildAgentRunProxySource', () => {
  it('injects the bearer token only into tools/call arguments and never prints it', async () => {
    const toolCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'toolManager_useTools',
        arguments: { tool: 'content read "note.md"' }
      }
    };
    const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

    const result = await exerciseProxy(
      [JSON.stringify(toolCall), JSON.stringify(toolsList)],
      'secret-agent-token',
      request => request.method === 'tools/list'
        ? {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              tools: [
                { name: 'toolManager_getTools', inputSchema: { type: 'object' } },
                { name: 'toolManager_useTools', inputSchema: { type: 'object' } }
              ]
            }
          }
        : { jsonrpc: '2.0', id: request.id, result: { accepted: true } }
    );

    expect(result.exitCode).toBe(0);
    expect(result.forwarded[0]).toHaveProperty(
      'params.arguments._agentCapabilityToken',
      'secret-agent-token'
    );
    expect(result.forwarded[1]).toEqual(toolsList);
    expect(result.stdout).not.toContain('secret-agent-token');
    expect(result.stderr).not.toContain('secret-agent-token');
  });

  it('returns a read-only initial tools/list catalog without mutating instructions', async () => {
    const toolsList = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} };
    const toolManager = new ToolManagerAgent({} as never, new Map());
    const liveCatalog = await new ToolListStrategy(
      {} as never,
      new Map([['toolManager', toolManager]]),
      true
    ).handle({ method: 'tools/list' });
    expect(JSON.stringify(liveCatalog)).toContain('content write');
    expect(JSON.stringify(liveCatalog)).toContain('storage move');

    const result = await exerciseProxy(
      [JSON.stringify(toolsList)],
      'secret-agent-token',
      request => ({
        jsonrpc: '2.0',
        id: request.id,
        result: liveCatalog
      })
    );

    const response = JSON.parse(result.stdout.trim()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    expect(result.exitCode).toBe(0);
    expect(response.result.tools.map(tool => tool.name)).toEqual([
      'toolManager_getTools',
      'toolManager_useTools'
    ]);
    expect(JSON.stringify(response)).not.toContain('content write');
    expect(JSON.stringify(response)).not.toContain('storage move');
    expect(JSON.stringify(response)).toContain('vault-readonly');
  });

  it('fails closed when Nexus returns a malformed tools/list catalog', async () => {
    const toolsList = { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} };
    const result = await exerciseProxy(
      [JSON.stringify(toolsList)],
      'secret-agent-token',
      request => ({ jsonrpc: '2.0', id: request.id, result: { accepted: true } })
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('secret-agent-token');
  });

  it('terminates non-zero on invalid JSON instead of forwarding it', async () => {
    const result = await exerciseProxy(['{invalid-json'], 'secret-agent-token');

    expect(result.exitCode).not.toBe(0);
    expect(result.forwarded).toEqual([]);
    expect(result.stdout).not.toContain('secret-agent-token');
    expect(result.stderr).not.toContain('secret-agent-token');
  });

  it('treats an empty input line as invalid JSON', async () => {
    const result = await exerciseProxy([''], 'secret-agent-token');

    expect(result.exitCode).not.toBe(0);
    expect(result.forwarded).toEqual([]);
  });
});
