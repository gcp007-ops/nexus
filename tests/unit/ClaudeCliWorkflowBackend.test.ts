import { App, Platform, Plugin } from 'obsidian';
import {
  ClaudeCliWorkflowBackend,
  NodeWorkflowTempArtifactFactory,
  type ClaudeCliWorkflowBackendDependencies,
  type WorkflowTempArtifacts,
  type WorkflowTempArtifactFactory
} from '../../src/services/workflows/ClaudeCliWorkflowBackend';
import {
  AgentCapabilityPolicyService
} from '../../src/services/workflows/AgentCapabilityPolicyService';
import type {
  WorkflowExecutionRequest
} from '../../src/services/workflows/WorkflowExecutionBackend';
import type {
  ClaudeHeadlessProcessHandle,
  ClaudeHeadlessProcessOptions,
  ClaudeHeadlessProcessResult,
  ClaudeHeadlessWorkflowRuntime
} from '../../src/services/external/ClaudeHeadlessService';

interface DeferredProcess extends ClaudeHeadlessProcessHandle {
  finish(result: ClaudeHeadlessProcessResult): void;
  fail(error: Error): void;
  terminateTree: jest.Mock<Promise<void>, []>;
}

class InMemoryTempArtifacts implements WorkflowTempArtifacts {
  readonly directory = '/tmp/nexus-agent-run-test';
  readonly proxyPath = `${this.directory}/agent-run-proxy.cjs`;
  readonly mcpConfigPath = `${this.directory}/mcp.json`;
  readonly writes = new Map<string, string>();
  cleanupCount = 0;
  cleanupFailuresRemaining = 0;
  failWriteAt: string | null = null;

  async writeFile(path: string, content: string): Promise<void> {
    if (path === this.failWriteAt) {
      throw new Error('temporary write failed');
    }
    this.writes.set(path, content);
  }

  async cleanup(): Promise<void> {
    this.cleanupCount += 1;
    if (this.cleanupFailuresRemaining > 0) {
      this.cleanupFailuresRemaining -= 1;
      throw new Error('temporary cleanup failed');
    }
  }
}

class InMemoryTempArtifactFactory implements WorkflowTempArtifactFactory {
  constructor(readonly artifacts: InMemoryTempArtifacts) {}

  async create(): Promise<WorkflowTempArtifacts> {
    return this.artifacts;
  }
}

function createDeferredProcess(terminationResult?: ClaudeHeadlessProcessResult): DeferredProcess {
  let resolveResult!: (result: ClaudeHeadlessProcessResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ClaudeHeadlessProcessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const terminateTree = jest.fn(async () => {
    if (terminationResult) {
      resolveResult(terminationResult);
    }
  });

  return {
    result,
    terminateTree,
    finish: resolveResult,
    fail: rejectResult
  };
}

function makeRequest(overrides: Partial<WorkflowExecutionRequest> = {}): WorkflowExecutionRequest {
  return {
    runId: 'run-1',
    prompt: 'Inspect the vault and return a proposal.',
    model: 'sonnet',
    maxTurns: 12,
    timeoutMs: 60_000,
    capabilityProfile: 'vault-readonly',
    ...overrides
  };
}

function createHarness(
  processHandle: DeferredProcess,
  authProcessHandle: DeferredProcess = createCompletedProcess({
    stdout: 'Authenticated',
    stderr: '',
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  }),
  runtimeOverrides: Partial<ClaudeHeadlessWorkflowRuntime> = {}
): {
  backend: ClaudeCliWorkflowBackend;
  artifacts: InMemoryTempArtifacts;
  policy: AgentCapabilityPolicyService;
  started: Promise<ClaudeHeadlessProcessOptions>;
  startAuthStatusProcess: jest.Mock<ClaudeHeadlessProcessHandle, [string, string?]>;
  startProcess: jest.Mock<ClaudeHeadlessProcessHandle, [ClaudeHeadlessProcessOptions]>;
} {
  const artifacts = new InMemoryTempArtifacts();
  const policy = new AgentCapabilityPolicyService(() => 'secret-agent-token');
  let resolveStarted!: (options: ClaudeHeadlessProcessOptions) => void;
  const started = new Promise<ClaudeHeadlessProcessOptions>((resolve) => {
    resolveStarted = resolve;
  });
  const runtime: ClaudeHeadlessWorkflowRuntime = {
    claudePath: '/mock/bin/claude',
    nodePath: '/mock/bin/node',
    vaultPath: '/mock/vault',
    ...runtimeOverrides
  };
  const startProcess = jest.fn((options: ClaudeHeadlessProcessOptions) => {
    resolveStarted(options);
    return processHandle;
  });
  const startAuthStatusProcess = jest.fn(() => authProcessHandle);
  const headlessService: ClaudeCliWorkflowBackendDependencies['headlessService'] = {
    getWorkflowRuntime: () => runtime,
    buildClaudeEnv: (extra) => ({ SAFE_PARENT: 'yes', ...extra }),
    startAuthStatusProcess,
    startProcess
  };
  const app = {
    vault: {
      getName: () => 'Test Vault'
    }
  } as unknown as App;
  const plugin = {
    manifest: {
      dir: '/mock/.obsidian/plugins/nexus'
    }
  } as unknown as Plugin;

  const backend = new ClaudeCliWorkflowBackend(app, plugin, {
    headlessService,
    capabilityPolicy: policy,
    tempArtifactFactory: new InMemoryTempArtifactFactory(artifacts)
  });

  return {
    backend,
    artifacts,
    policy,
    started,
    startAuthStatusProcess,
    startProcess
  };
}

function createCompletedProcess(result: ClaudeHeadlessProcessResult): DeferredProcess {
  const processHandle = createDeferredProcess();
  processHandle.finish(result);
  return processHandle;
}

describe('ClaudeCliWorkflowBackend', () => {
  beforeEach(() => {
    Platform.isDesktop = true;
    Platform.isWin = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns immediately with a cancellable handle and cancels idempotently', async () => {
    const processHandle = createDeferredProcess({
      stdout: 'partial secret-agent-token',
      stderr: 'diagnostic secret-agent-token',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, artifacts, policy, started } = createHarness(processHandle);

    const handle = backend.start(makeRequest());

    expect(handle).not.toBeInstanceOf(Promise);
    expect(handle.runId).toBe('run-1');
    expect(typeof handle.cancel).toBe('function');

    const processOptions = await started;
    await Promise.all([handle.cancel(), handle.cancel()]);
    const result = await handle.result;

    expect(processHandle.terminateTree).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      runId: 'run-1',
      status: 'cancelled',
      exitCode: null
    });
    expect(JSON.stringify(result)).not.toContain('secret-agent-token');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).toContain('[REDACTED]');
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);

    expect(processOptions.command).toBe('/mock/bin/claude');
    expect((processOptions as ClaudeHeadlessProcessOptions & { shell?: boolean }).shell).toBe(false);
    expect(processOptions.args).toEqual([
      '-p',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      artifacts.mcpConfigPath,
      '--allowedTools',
      'mcp__nexus-test-vault__toolManager_getTools',
      'mcp__nexus-test-vault__toolManager_useTools',
      '--tools',
      '',
      '--disable-slash-commands',
      '--output-format',
      'text',
      '--max-turns',
      '12',
      '--model',
      'sonnet'
    ]);
    expect(processOptions.args.filter((arg) => arg.startsWith('mcp__'))).toEqual([
      'mcp__nexus-test-vault__toolManager_getTools',
      'mcp__nexus-test-vault__toolManager_useTools'
    ]);
    expect(processOptions.args.filter((arg) => arg === '--safe-mode')).toEqual([
      '--safe-mode'
    ]);
    expect(processOptions.args).not.toContain('--dangerously-skip-permissions');
    expect(processOptions.stdinText).toBe('Inspect the vault and return a proposal.');
    expect(processOptions.env).toMatchObject({
      NEXUS_AGENT_RUN_TOKEN: 'secret-agent-token',
      NEXUS_MCP_SOCKET_PATH: '/tmp/nexus_mcp_test-vault.sock'
    });

    const config = JSON.parse(artifacts.writes.get(artifacts.mcpConfigPath) ?? '{}') as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(config.mcpServers['nexus-test-vault']).toEqual({
      type: 'stdio',
      command: '/mock/bin/node',
      args: [artifacts.proxyPath]
    });
    expect(artifacts.writes.get(artifacts.proxyPath)).toContain('NEXUS_AGENT_RUN_TOKEN');
    expect(JSON.stringify(Array.from(artifacts.writes.entries()))).not.toContain('secret-agent-token');
  });

  it('rejects model metacharacters before any child receives the capability environment', async () => {
    const processHandle = createCompletedProcess({
      stdout: 'unexpected',
      stderr: '',
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, startAuthStatusProcess, startProcess } = createHarness(processHandle);

    const result = await backend.start(makeRequest({
      model: 'sonnet & calc.exe'
    })).result;

    expect(result.status).toBe('preflight_failed');
    expect(result.stderr).toContain('sonnet');
    expect(startAuthStatusProcess).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('fails closed on Windows command wrappers before authentication starts', async () => {
    Platform.isWin = true;
    const processHandle = createCompletedProcess({
      stdout: 'unexpected',
      stderr: '',
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, startAuthStatusProcess, startProcess } = createHarness(
      processHandle,
      undefined,
      { claudePath: 'C:\\Users\\test\\claude.cmd' }
    );

    const result = await backend.start(makeRequest()).result;

    expect(result.status).toBe('preflight_failed');
    expect(result.stderr).toContain('native Claude executable');
    expect(startAuthStatusProcess).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('fails closed when the Windows MCP runtime is a command wrapper', async () => {
    Platform.isWin = true;
    const processHandle = createCompletedProcess({
      stdout: 'unexpected',
      stderr: '',
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, startAuthStatusProcess, startProcess } = createHarness(
      processHandle,
      undefined,
      {
        claudePath: 'C:\\Program Files\\Claude\\claude.exe',
        nodePath: 'C:\\Users\\test\\node.cmd'
      }
    );

    const result = await backend.start(makeRequest()).result;

    expect(result.status).toBe('preflight_failed');
    expect(result.stderr).toContain('native Node.js executable');
    expect(startAuthStatusProcess).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('terminates the process tree on timeout and preserves partial output', async () => {
    jest.useFakeTimers();
    const processHandle = createDeferredProcess({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, artifacts, policy, started } = createHarness(processHandle);

    const handle = backend.start(makeRequest({ timeoutMs: 10 }));
    await started;
    await jest.advanceTimersByTimeAsync(10);
    const result = await handle.result;

    expect(result).toMatchObject({
      status: 'timed_out',
      stdout: 'partial'
    });
    expect(processHandle.terminateTree).toHaveBeenCalledTimes(1);
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);
  });

  it('keeps a completed process terminal when cancel arrives late', async () => {
    const processHandle = createDeferredProcess();
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    const handle = backend.start(makeRequest());
    await started;

    processHandle.finish({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
    await handle.cancel();

    expect(processHandle.terminateTree).not.toHaveBeenCalled();
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);
  });

  it('terminates a retained process when its result rejects before cleanup', async () => {
    const processHandle = createDeferredProcess();
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    const handle = backend.start(makeRequest());
    await started;

    processHandle.fail(new Error('runner result failed'));
    const result = await handle.result;

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.stderr).toContain('runner result failed');
    expect(processHandle.terminateTree).toHaveBeenCalledTimes(1);
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);
  });

  it('reports failed rather than cancelled when tree termination is unconfirmed', async () => {
    const processHandle = createDeferredProcess();
    processHandle.terminateTree.mockRejectedValue(
      new Error('process tree termination was not confirmed')
    );
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    const handle = backend.start(makeRequest());
    await started;

    const cancellation = handle.cancel();
    processHandle.finish({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const result = await handle.result;
    await cancellation;

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('process tree termination was not confirmed');
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);
  });

  it('reports failed rather than cancelled when temporary cleanup fails', async () => {
    const processHandle = createDeferredProcess({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    artifacts.cleanupFailuresRemaining = 2;
    const handle = backend.start(makeRequest());
    await started;

    await handle.cancel();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('temporary cleanup failed');
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(2);
  });

  it('reports failed rather than timed out when temporary cleanup fails', async () => {
    jest.useFakeTimers();
    const processHandle = createDeferredProcess({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    artifacts.cleanupFailuresRemaining = 2;
    const handle = backend.start(makeRequest({ timeoutMs: 10 }));
    await started;

    await jest.advanceTimersByTimeAsync(10);
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('temporary cleanup failed');
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(2);
  });

  it('retries a transient cleanup rejection before returning cancelled', async () => {
    const processHandle = createDeferredProcess({
      stdout: 'partial',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const { backend, artifacts, policy, started } = createHarness(processHandle);
    artifacts.cleanupFailuresRemaining = 1;
    const handle = backend.start(makeRequest());
    await started;

    await handle.cancel();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(result.stderr).not.toContain('temporary cleanup failed');
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(2);
  });

  it('cancels a retained authentication preflight without starting the workflow process', async () => {
    const authProcess = createDeferredProcess({
      stdout: '',
      stderr: '',
      exitCode: null,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const processHandle = createDeferredProcess();
    const { backend, artifacts, policy, startProcess } = createHarness(
      processHandle,
      authProcess
    );

    const handle = backend.start(makeRequest());
    await handle.cancel();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(authProcess.terminateTree).toHaveBeenCalledTimes(1);
    expect(startProcess).not.toHaveBeenCalled();
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(0);
  });

  it('reports an unauthenticated Claude CLI as a preflight failure', async () => {
    const authProcess = createCompletedProcess({
      stdout: 'Not authenticated',
      stderr: '',
      exitCode: 1,
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const processHandle = createDeferredProcess();
    const { backend, artifacts, startProcess } = createHarness(
      processHandle,
      authProcess
    );

    const result = await backend.start(makeRequest()).result;

    expect(result).toMatchObject({
      status: 'preflight_failed',
      stdout: 'Not authenticated',
      exitCode: 1
    });
    expect(startProcess).not.toHaveBeenCalled();
    expect(artifacts.cleanupCount).toBe(0);
  });

  it('revokes the token and cleans partial artifacts when setup fails', async () => {
    const processHandle = createDeferredProcess();
    const { backend, artifacts, policy } = createHarness(processHandle);
    artifacts.failWriteAt = artifacts.mcpConfigPath;

    const result = await backend.start(makeRequest()).result;

    expect(result).toMatchObject({
      status: 'preflight_failed',
      stdout: '',
      exitCode: null
    });
    expect(result.stderr).toContain('temporary write failed');
    expect(processHandle.terminateTree).not.toHaveBeenCalled();
    expect(policy.resolve('secret-agent-token')).toBeUndefined();
    expect(artifacts.cleanupCount).toBe(1);
  });

  it('removes the real temporary proxy and config directory', async () => {
    const fsPromises = await import('fs/promises');
    const artifacts = await new NodeWorkflowTempArtifactFactory().create();

    try {
      await artifacts.writeFile(artifacts.proxyPath, 'proxy');
      await artifacts.writeFile(artifacts.mcpConfigPath, '{}');
      await expect(fsPromises.readFile(artifacts.proxyPath, 'utf8')).resolves.toBe('proxy');

      await artifacts.cleanup();

      await expect(fsPromises.access(artifacts.directory)).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await artifacts.cleanup();
    }
  });

  it('retries temporary directory removal after a rejected cleanup', async () => {
    const activeWindow = window.activeWindow as Window & {
      require: (moduleId: string) => unknown;
    };
    const originalRequire = activeWindow.require;
    const rm = jest.fn<Promise<void>, [string, { recursive: boolean; force: boolean }]>()
      .mockRejectedValueOnce(new Error('directory is busy'))
      .mockResolvedValueOnce(undefined);
    const fsPromises = {
      mkdtemp: jest.fn(async () => '/tmp/nexus-agent-run-retry'),
      writeFile: jest.fn(async () => undefined),
      rm
    };
    const requireSpy = jest.spyOn(activeWindow, 'require').mockImplementation((moduleId) => {
      return moduleId === 'fs/promises' ? fsPromises : originalRequire(moduleId);
    });

    try {
      const artifacts = await new NodeWorkflowTempArtifactFactory().create();

      await expect(artifacts.cleanup()).rejects.toThrow('directory is busy');
      await expect(artifacts.cleanup()).resolves.toBeUndefined();

      expect(rm).toHaveBeenCalledTimes(2);
    } finally {
      requireSpy.mockRestore();
    }
  });
});
