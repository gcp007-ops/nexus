import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { App, Plugin, Platform } from 'obsidian';
import {
  ClaudeHeadlessService,
  type ClaudeHeadlessProcessResult,
  type ClaudeHeadlessServiceDependencies
} from '../../src/services/external/ClaudeHeadlessService';

jest.mock('../../src/utils/desktopProcess', () => ({
  spawnDesktopProcess: jest.fn()
}));

type MockChildProcess = EventEmitter & {
  pid?: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 42;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  return child;
}

type ClaudeHeadlessServiceWithRunProcess = ClaudeHeadlessService & {
  runProcess: (
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
    stdinText?: string
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    errorCode?: string;
  }>;
};

describe('ClaudeHeadlessService', () => {
  const { spawnDesktopProcess } = jest.requireMock('../../src/utils/desktopProcess') as {
    spawnDesktopProcess: jest.Mock;
  };
  let service: ClaudeHeadlessService;

  beforeEach(() => {
    Platform.isDesktop = true;
    Platform.isWin = false;
    service = new ClaudeHeadlessService(
      {
        vault: {
          getName: () => 'Test Vault'
        }
      } as unknown as App,
      {
        manifest: {
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        }
      } as unknown as Plugin
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the prompt through stdin and keeps the argv payload bounded', async () => {
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    const runProcess = jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess').mockImplementation(
      async (_command: string, args: string[], cwd?: string, _env?: NodeJS.ProcessEnv, stdinText?: string) => {
        expect(args).toEqual([
          '-p',
          '--strict-mcp-config',
          '--mcp-config',
          expect.any(String),
          '--tools',
          '',
          '--disable-slash-commands',
          '--output-format',
          'text',
          '--max-turns',
          '8',
          '--model',
          'claude-sonnet-4-6'
        ]);
        expect(stdinText).toBe('Summarize the regression');
        expect(cwd).toBe('/mock/vault');

        return {
          stdout: 'Claude output',
          stderr: '',
          exitCode: 0
        };
      }
    );

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'claude-sonnet-4-6',
      bypassPermissions: true
    });

    expect(runProcess).toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      stdout: 'Claude output',
      stderr: '',
      exitCode: 0,
      commandLine: expect.stringContaining('--model claude-sonnet-4-6')
    });
    expect(result.commandLine).not.toContain('Summarize the regression');
    expect(result.commandLine).not.toContain('--dangerously-skip-permissions');
  });

  it('maps local CLI transport errors to a clear failure message', async () => {
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess').mockResolvedValue({
      stdout: '',
      stderr: 'spawn E2BIG',
      exitCode: null,
      errorCode: 'E2BIG'
    });

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'claude-sonnet-4-6'
    });

    expect(result).toMatchObject({
      success: false,
      exitCode: null
    });
    expect(result.stderr).toContain('Claude headless command is too large for local CLI transport');
  });

  it('blocks oversized argv payloads on Windows before spawn', async () => {
    Platform.isWin = true;
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    const runProcess = jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess');

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'x'.repeat(30_000)
    });

    expect(runProcess).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Claude headless command is too large for Windows argv transport');
  });

  it('passes capability variables only when explicitly supplied for a workflow child', () => {
    const previousToken = process.env.NEXUS_AGENT_RUN_TOKEN;
    const previousSocket = process.env.NEXUS_MCP_SOCKET_PATH;
    const previousAlternateToken = process.env.nexus_agent_run_token;
    const previousAlternateSocket = process.env.NeXuS_McP_SoCkEt_PaTh;
    process.env.NEXUS_AGENT_RUN_TOKEN = 'stale-parent-token';
    process.env.NEXUS_MCP_SOCKET_PATH = '/tmp/stale-parent.sock';
    process.env.nexus_agent_run_token = 'stale-alternate-token';
    process.env.NeXuS_McP_SoCkEt_PaTh = '/tmp/stale-alternate.sock';

    try {
      const inheritedCapabilityKeys = Object.keys(service.buildClaudeEnv()).filter((key) =>
        key.toUpperCase() === 'NEXUS_AGENT_RUN_TOKEN'
        || key.toUpperCase() === 'NEXUS_MCP_SOCKET_PATH'
      );
      expect(inheritedCapabilityKeys).toEqual([]);

      const explicitEnv = service.buildClaudeEnv({
        NEXUS_AGENT_RUN_TOKEN: 'fresh-run-token',
        NEXUS_MCP_SOCKET_PATH: '/tmp/fresh-run.sock'
      });
      expect(explicitEnv).toMatchObject({
        NEXUS_AGENT_RUN_TOKEN: 'fresh-run-token',
        NEXUS_MCP_SOCKET_PATH: '/tmp/fresh-run.sock'
      });
      expect(Object.keys(explicitEnv).filter((key) =>
        key.toUpperCase() === 'NEXUS_AGENT_RUN_TOKEN'
        || key.toUpperCase() === 'NEXUS_MCP_SOCKET_PATH'
      )).toEqual([
        'NEXUS_AGENT_RUN_TOKEN',
        'NEXUS_MCP_SOCKET_PATH'
      ]);
    } finally {
      if (previousToken === undefined) {
        delete process.env.NEXUS_AGENT_RUN_TOKEN;
      } else {
        process.env.NEXUS_AGENT_RUN_TOKEN = previousToken;
      }
      if (previousSocket === undefined) {
        delete process.env.NEXUS_MCP_SOCKET_PATH;
      } else {
        process.env.NEXUS_MCP_SOCKET_PATH = previousSocket;
      }
      if (previousAlternateToken === undefined) {
        delete process.env.nexus_agent_run_token;
      } else {
        process.env.nexus_agent_run_token = previousAlternateToken;
      }
      if (previousAlternateSocket === undefined) {
        delete process.env.NeXuS_McP_SoCkEt_PaTh;
      } else {
        process.env.NeXuS_McP_SoCkEt_PaTh = previousAlternateSocket;
      }
    }
  });

  it('caps captured output and ignores terminal events after close', async () => {
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);

    const handle = service.startProcess({
      command: '/mock/bin/claude',
      args: ['-p'],
      stdinText: 'Prompt from stdin',
      maxOutputChars: 7
    });

    child.stdout.write('12345');
    child.stdout.write('67890');
    child.stderr.write('stderr overflow');
    child.emit('close', 0);
    expect(child.listenerCount('error')).toBe(0);
    child.once('error', () => undefined);
    child.emit('error', new Error('late error'));

    await expect(handle.result).resolves.toEqual<ClaudeHeadlessProcessResult>({
      stdout: '1234567',
      stderr: 'stderr ',
      stdoutTruncated: true,
      stderrTruncated: true,
      exitCode: 0
    });
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it('passes Windows argv literally with shell execution disabled', async () => {
    Platform.isWin = true;
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);
    const options: Parameters<ClaudeHeadlessService['startProcess']>[0] & {
      shell: boolean;
    } = {
      command: 'C:\\Program Files\\Claude\\claude.exe',
      args: ['--model', 'sonnet'],
      shell: false
    };

    const handle = service.startProcess(options);

    expect(spawnDesktopProcess).toHaveBeenCalledWith(
      expect.anything(),
      'C:\\Program Files\\Claude\\claude.exe',
      ['--model', 'sonnet'],
      expect.objectContaining({ shell: false })
    );
    child.emit('close', 0);
    await expect(handle.result).resolves.toMatchObject({ exitCode: 0 });
  });

  it('keeps the first process error when a close event arrives late', async () => {
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);
    const handle = service.startProcess({
      command: '/mock/bin/claude',
      args: ['-p'],
      terminationGraceMs: 0
    });

    child.emit('error', Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }));
    child.emit('close', 0);

    await expect(handle.result).resolves.toMatchObject({
      stderr: 'spawn E2BIG',
      exitCode: null,
      errorCode: 'E2BIG'
    });
  });

  it('confirms child termination before resolving a missing-pipe failure', async () => {
    const child = createMockChildProcess();
    child.stdout = null as unknown as PassThrough;
    spawnDesktopProcess.mockReturnValue(child);
    const controlledService = new ClaudeHeadlessService(
      {} as App,
      {} as Plugin,
      {
        signalProcessTree: async () => {
          child.emit('close', null);
        },
        isProcessTreeAlive: async () => false
      }
    );

    const handle = controlledService.startProcess({
      command: '/mock/bin/claude',
      args: ['-p'],
      terminationGraceMs: 0
    });
    const observed = await Promise.race([
      handle.result,
      new Promise<'not-settled'>((resolve) => {
        window.setTimeout(() => resolve('not-settled'), 5);
      })
    ]);

    expect(observed).toMatchObject({
      stderr: 'Failed to capture Claude Code process output.',
      exitCode: null
    });
  });

  it('terminates the process tree with TERM then KILL and is idempotent', async () => {
    jest.useFakeTimers();
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);
    const signals: NodeJS.Signals[] = [];
    const controlledService = new ClaudeHeadlessService(
      {} as App,
      {} as Plugin,
      {
        signalProcessTree: async (_child, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') {
            child.emit('close', null);
          }
        },
        isProcessTreeAlive: async () => false
      }
    );
    const handle = controlledService.startProcess({
      command: '/mock/bin/claude',
      args: ['-p'],
      terminationGraceMs: 10
    });

    const firstTermination = handle.terminateTree();
    const secondTermination = handle.terminateTree();
    await Promise.resolve();
    expect(signals).toEqual(['SIGTERM']);

    await jest.advanceTimersByTimeAsync(10);
    await Promise.all([firstTermination, secondTermination]);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    await handle.terminateTree();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(handle.result).resolves.toMatchObject({ exitCode: null });
    jest.useRealTimers();
  });

  it('kills a POSIX process group after grace even when the root closes on TERM', async () => {
    jest.useFakeTimers();
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);
    const signals: NodeJS.Signals[] = [];
    let treeAlive = true;
    const dependencies: ClaudeHeadlessServiceDependencies & {
      isProcessTreeAlive: () => Promise<boolean>;
    } = {
      signalProcessTree: async (_child, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          child.emit('close', null);
        } else {
          treeAlive = false;
        }
      },
      isProcessTreeAlive: async () => treeAlive
    };
    const controlledService = new ClaudeHeadlessService(
      {} as App,
      {} as Plugin,
      dependencies
    );
    const handle = controlledService.startProcess({
      command: '/mock/bin/claude',
      args: ['-p'],
      terminationGraceMs: 10
    });

    const termination = handle.terminateTree();
    await Promise.resolve();
    expect(signals).toEqual(['SIGTERM']);

    await jest.advanceTimersByTimeAsync(10);
    await termination;

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(treeAlive).toBe(false);
    jest.useRealTimers();
  });

  it('rejects termination when Windows taskkill reports failure', async () => {
    Platform.isWin = true;
    const child = createMockChildProcess();
    spawnDesktopProcess.mockReturnValue(child);
    const taskkill = new EventEmitter();
    const childProcessModule = require('child_process') as typeof import('child_process');
    const taskkillSpawn = jest.spyOn(childProcessModule, 'spawn').mockReturnValue(
      taskkill as ReturnType<typeof childProcessModule.spawn>
    );
    const handle = service.startProcess({
      command: 'C:\\Program Files\\Claude\\claude.exe',
      args: ['-p'],
      shell: false,
      terminationGraceMs: 10
    });

    const termination = handle.terminateTree();
    const observedTermination = termination.then(
      () => null,
      (error: unknown) => error
    );
    await Promise.resolve();
    expect(taskkillSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '42', '/T'],
      expect.objectContaining({ windowsHide: true })
    );

    taskkill.emit('close', 1);
    child.emit('close', null);

    await expect(observedTermination).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('taskkill') })
    );
    await handle.result;
  });
});
