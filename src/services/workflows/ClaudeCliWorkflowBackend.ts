import { App, Platform, Plugin } from 'obsidian';
import {
  getPrimaryIpcPath,
  getPrimaryServerKey
} from '../../constants/branding';
import {
  ClaudeHeadlessService,
  type ClaudeHeadlessProcessHandle,
  type ClaudeHeadlessProcessOptions,
  type ClaudeHeadlessWorkflowRuntime
} from '../external/ClaudeHeadlessService';
import {
  AgentCapabilityPolicyService,
  agentCapabilityPolicyService
} from './AgentCapabilityPolicyService';
import { buildAgentRunProxySource } from './AgentRunProxySource';
import type {
  WorkflowExecutionBackend,
  WorkflowExecutionHandle,
  WorkflowExecutionRequest,
  WorkflowExecutionResult,
  WorkflowExecutionStatus
} from './WorkflowExecutionBackend';

const WORKFLOW_OUTPUT_LIMIT_CHARS = 1024 * 1024;
const CAPABILITY_EXPIRY_MARGIN_MS = 60_000;

type WorkflowDesktopModuleMap = {
  'fs/promises': typeof import('fs/promises');
  os: typeof import('os');
  path: typeof import('path');
};

type WorkflowHeadlessService = Pick<
  ClaudeHeadlessService,
  | 'getWorkflowRuntime'
  | 'buildClaudeEnv'
  | 'startAuthStatusProcess'
  | 'startProcess'
>;

type WorkflowCapabilityPolicy = Pick<
  AgentCapabilityPolicyService,
  'issue' | 'revoke'
>;

export interface WorkflowTempArtifacts {
  readonly directory: string;
  readonly proxyPath: string;
  readonly mcpConfigPath: string;
  writeFile(path: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface WorkflowTempArtifactFactory {
  create(): Promise<WorkflowTempArtifacts>;
}

export interface ClaudeCliWorkflowBackendDependencies {
  headlessService: WorkflowHeadlessService;
  capabilityPolicy: WorkflowCapabilityPolicy;
  tempArtifactFactory: WorkflowTempArtifactFactory;
  now: () => number;
}

interface ExecutionState {
  terminalIntent: Extract<WorkflowExecutionStatus, 'cancelled' | 'timed_out'> | null;
  terminalLocked: boolean;
  processHandle: ClaudeHeadlessProcessHandle | null;
  termination: Promise<void> | null;
  terminationError: string | null;
}

interface ResolvedWorkflowRuntime {
  claudePath: string;
  nodePath: string;
  vaultPath: string;
}

export class NodeWorkflowTempArtifactFactory implements WorkflowTempArtifactFactory {
  async create(): Promise<WorkflowTempArtifacts> {
    const fsPromises = this.loadDesktopModule('fs/promises');
    const osMod = this.loadDesktopModule('os');
    const pathMod = this.loadDesktopModule('path');
    const directory = await fsPromises.mkdtemp(
      pathMod.join(osMod.tmpdir(), 'nexus-agent-run-')
    );
    const proxyPath = pathMod.join(directory, 'agent-run-proxy.cjs');
    const mcpConfigPath = pathMod.join(directory, 'mcp.json');
    let cleanupPromise: Promise<void> | null = null;

    return {
      directory,
      proxyPath,
      mcpConfigPath,
      writeFile: async (path: string, content: string) => {
        await fsPromises.writeFile(path, content, {
          encoding: 'utf8',
          mode: 0o600
        });
      },
      cleanup: async () => {
        cleanupPromise ??= fsPromises.rm(directory, {
          recursive: true,
          force: true
        }).catch((error) => {
          cleanupPromise = null;
          throw error;
        });
        await cleanupPromise;
      }
    };
  }

  private loadDesktopModule<TModuleName extends keyof WorkflowDesktopModuleMap>(
    moduleName: TModuleName
  ): WorkflowDesktopModuleMap[TModuleName] {
    if (!Platform.isDesktop) {
      throw new Error(`${moduleName} is only available on desktop.`);
    }

    const maybeRequire = (window.activeWindow as Window & {
      require?: (moduleId: string) => unknown;
    }).require;
    if (typeof maybeRequire !== 'function') {
      throw new Error('Desktop module loader is unavailable.');
    }
    return maybeRequire(moduleName) as WorkflowDesktopModuleMap[TModuleName];
  }
}

export class ClaudeCliWorkflowBackend implements WorkflowExecutionBackend {
  private readonly dependencies: ClaudeCliWorkflowBackendDependencies;

  constructor(
    private readonly app: App,
    plugin: Plugin,
    overrides: Partial<ClaudeCliWorkflowBackendDependencies> = {}
  ) {
    this.dependencies = {
      headlessService: overrides.headlessService ?? new ClaudeHeadlessService(app, plugin),
      capabilityPolicy: overrides.capabilityPolicy ?? agentCapabilityPolicyService,
      tempArtifactFactory: overrides.tempArtifactFactory ?? new NodeWorkflowTempArtifactFactory(),
      now: overrides.now ?? (() => Date.now())
    };
  }

  start(request: WorkflowExecutionRequest): WorkflowExecutionHandle {
    const state: ExecutionState = {
      terminalIntent: null,
      terminalLocked: false,
      processHandle: null,
      termination: null,
      terminationError: null
    };
    let result: Promise<WorkflowExecutionResult>;

    const requestTermination = (
      status: Extract<WorkflowExecutionStatus, 'cancelled' | 'timed_out'>
    ): Promise<void> => {
      if (!state.terminalLocked && state.terminalIntent === null) {
        state.terminalIntent = status;
      }
      this.startTerminationIfNeeded(state);
      return result.then(() => undefined);
    };

    const coreResult = this.execute(request, state);
    const timeout = this.isPositiveFinite(request.timeoutMs)
      ? window.setTimeout(() => {
          void requestTermination('timed_out');
        }, request.timeoutMs)
      : null;
    result = coreResult.finally(() => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
    });

    return {
      runId: request.runId,
      result,
      cancel: () => requestTermination('cancelled')
    };
  }

  private async execute(
    request: WorkflowExecutionRequest,
    state: ExecutionState
  ): Promise<WorkflowExecutionResult> {
    const startedAt = this.dependencies.now();
    let token: string | null = null;
    let artifacts: WorkflowTempArtifacts | null = null;
    let status: WorkflowExecutionStatus = 'preflight_failed';
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let exitCode: number | null = null;
    let workflowProcessStarted = false;

    try {
      const validationError = this.validateRequest(request);
      if (validationError) {
        stderr = validationError;
      } else if (state.terminalIntent) {
        status = state.terminalIntent;
      } else {
        const runtime = this.dependencies.headlessService.getWorkflowRuntime();
        if (!this.validateRuntime(runtime)) {
          stderr = this.validateRuntimeMessage(runtime);
        } else {
          state.processHandle = this.dependencies.headlessService.startAuthStatusProcess(
            runtime.claudePath,
            runtime.vaultPath
          );
          this.startTerminationIfNeeded(state);
          const authResult = await state.processHandle.result;
          await Promise.resolve(state.termination);
          state.processHandle = null;
          state.termination = null;
          stdout = authResult.stdout;
          stderr = authResult.stderr;
          stdoutTruncated = authResult.stdoutTruncated;
          stderrTruncated = authResult.stderrTruncated;
          exitCode = authResult.exitCode;

          if (state.terminalIntent) {
            status = state.terminalIntent;
          } else if (authResult.exitCode !== 0) {
            status = 'preflight_failed';
          } else {
            stdout = '';
            stderr = '';
            stdoutTruncated = false;
            stderrTruncated = false;
            exitCode = null;
            artifacts = await this.dependencies.tempArtifactFactory.create();

            if (state.terminalIntent) {
              status = state.terminalIntent;
            } else {
              await artifacts.writeFile(
                artifacts.proxyPath,
                buildAgentRunProxySource()
              );

              if (state.terminalIntent) {
                status = state.terminalIntent;
              } else {
                const issued = this.dependencies.capabilityPolicy.issue(
                  request.runId,
                  request.capabilityProfile,
                  this.capabilityTtlMs(request.timeoutMs)
                );
                token = issued.token;
                await artifacts.writeFile(
                  artifacts.mcpConfigPath,
                  JSON.stringify(
                    this.buildMcpConfig(runtime.nodePath, artifacts.proxyPath, token),
                    null,
                    2
                  )
                );

                if (state.terminalIntent) {
                  status = state.terminalIntent;
                } else {
                  state.processHandle = this.dependencies.headlessService.startProcess(
                    this.buildProcessOptions(request, runtime, artifacts)
                  );
                  workflowProcessStarted = true;
                  this.startTerminationIfNeeded(state);
                  const processResult = await state.processHandle.result;
                  await Promise.resolve(state.termination);
                  state.terminalLocked = true;
                  stdout = processResult.stdout;
                  stderr = processResult.stderr;
                  stdoutTruncated = processResult.stdoutTruncated;
                  stderrTruncated = processResult.stderrTruncated;
                  exitCode = processResult.exitCode;
                  status = state.terminalIntent ?? (
                    processResult.exitCode === 0 ? 'completed' : 'failed'
                  );
                }
              }
            }
          }
        }
      }
    } catch (error) {
      state.terminalLocked = true;
      this.startRetainedProcessTermination(state);
      await Promise.resolve(state.termination);
      state.processHandle = null;
      status = state.terminalIntent ?? (
        workflowProcessStarted ? 'failed' : 'preflight_failed'
      );
      stderr = this.appendDiagnostic(stderr, this.errorMessage(error));
    }

    state.terminalLocked = true;
    if (state.terminationError) {
      stderr = this.appendDiagnostic(stderr, state.terminationError);
      status = 'failed';
    }

    if (token) {
      try {
        this.dependencies.capabilityPolicy.revoke(token);
      } catch (error) {
        stderr = this.appendDiagnostic(stderr, this.errorMessage(error));
        if (status === 'completed') {
          status = 'failed';
        }
      }
    }

    if (artifacts) {
      let cleanupError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await artifacts.cleanup();
          cleanupError = null;
          break;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) {
        stderr = this.appendDiagnostic(
          stderr,
          `Failed to remove temporary workflow files: ${this.errorMessage(cleanupError)}`
        );
        status = 'failed';
      }
    }

    return {
      runId: request.runId,
      status,
      stdout: this.redactToken(stdout, token),
      stderr: this.redactToken(stderr, token),
      stdoutTruncated,
      stderrTruncated,
      exitCode,
      durationMs: Math.max(0, this.dependencies.now() - startedAt)
    };
  }

  private startTerminationIfNeeded(state: ExecutionState): void {
    if (!state.terminalIntent) {
      return;
    }
    this.startRetainedProcessTermination(state);
  }

  private startRetainedProcessTermination(state: ExecutionState): void {
    if (!state.processHandle || state.termination) {
      return;
    }
    const processHandle = state.processHandle;
    state.termination = Promise.resolve().then(
      () => processHandle.terminateTree()
    ).catch((error) => {
      state.terminationError = `Failed to terminate Claude process tree: ${this.errorMessage(error)}`;
    });
  }

  private buildProcessOptions(
    request: WorkflowExecutionRequest,
    runtime: ResolvedWorkflowRuntime,
    artifacts: WorkflowTempArtifacts
  ): ClaudeHeadlessProcessOptions {
    const allowedMcpTools = this.buildAllowedMcpTools();
    return {
      command: runtime.claudePath,
      shell: false,
      args: [
        '-p',
        '--safe-mode',
        '--strict-mcp-config',
        '--mcp-config',
        artifacts.mcpConfigPath,
        '--allowedTools',
        ...allowedMcpTools,
        '--tools',
        '',
        '--disable-slash-commands',
        '--output-format',
        'text',
        '--max-turns',
        String(request.maxTurns),
        '--model',
        request.model.trim()
      ],
      cwd: runtime.vaultPath,
      env: this.dependencies.headlessService.buildClaudeEnv({
        NEXUS_MCP_SOCKET_PATH: getPrimaryIpcPath(
          this.app.vault.getName(),
          Platform.isWin
        )
      }),
      stdinText: request.prompt.trim(),
      maxOutputChars: WORKFLOW_OUTPUT_LIMIT_CHARS
    };
  }

  private buildAllowedMcpTools(): [string, string] {
    const serverKey = getPrimaryServerKey(this.app.vault.getName());
    return [
      `mcp__${serverKey}__toolManager_getTools`,
      `mcp__${serverKey}__toolManager_useTools`
    ];
  }

  private buildMcpConfig(
    nodePath: string,
    proxyPath: string,
    token: string
  ): Record<string, unknown> {
    return {
      mcpServers: {
        [getPrimaryServerKey(this.app.vault.getName())]: {
          type: 'stdio',
          command: nodePath,
          args: [proxyPath],
          env: {
            NEXUS_AGENT_RUN_TOKEN: token,
            NEXUS_MCP_SOCKET_PATH: getPrimaryIpcPath(
              this.app.vault.getName(),
              Platform.isWin
            )
          }
        }
      }
    };
  }

  private validateRequest(request: WorkflowExecutionRequest): string | null {
    if (request.runId.trim().length === 0) {
      return 'runId is required for Claude workflow execution.';
    }
    if (request.prompt.trim().length === 0) {
      return 'Prompt is required for Claude workflow execution.';
    }
    if (request.model.trim().length === 0) {
      return 'Model is required for Claude workflow execution.';
    }
    if (request.model.trim() !== 'sonnet') {
      return 'Only the sonnet model alias is supported for Claude workflow execution.';
    }
    if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1) {
      return 'maxTurns must be a positive integer.';
    }
    if (!this.isPositiveFinite(request.timeoutMs)) {
      return 'timeoutMs must be a positive finite number.';
    }
    if (request.capabilityProfile !== 'vault-readonly') {
      return 'Only the vault-readonly capability profile is supported.';
    }
    return null;
  }

  private validateRuntime(
    runtime: ClaudeHeadlessWorkflowRuntime
  ): runtime is ResolvedWorkflowRuntime {
    if (
      !Platform.isDesktop
      || !runtime.claudePath
      || !runtime.nodePath
      || !runtime.vaultPath
    ) {
      return false;
    }
    return this.isSafeNativeWindowsExecutable(runtime.claudePath)
      && this.isSafeNativeWindowsExecutable(runtime.nodePath);
  }

  private validateRuntimeMessage(runtime: ClaudeHeadlessWorkflowRuntime): string {
    if (!Platform.isDesktop) {
      return 'Claude workflow execution is only available on desktop.';
    }
    if (!runtime.claudePath) {
      return 'Claude Code was not found on PATH.';
    }
    if (!runtime.nodePath) {
      return 'Node.js was not found on PATH.';
    }
    if (runtime.claudePath && !this.isSafeNativeWindowsExecutable(runtime.claudePath)) {
      return 'Supervised execution requires a native Claude executable on Windows; .cmd and .bat wrappers are not allowed.';
    }
    if (runtime.nodePath && !this.isSafeNativeWindowsExecutable(runtime.nodePath)) {
      return 'Supervised execution requires a native Node.js executable on Windows; .cmd and .bat wrappers are not allowed.';
    }
    return 'Vault base path is unavailable.';
  }

  private isSafeNativeWindowsExecutable(command: string): boolean {
    return !Platform.isWin || /\.exe$/iu.test(command);
  }

  private capabilityTtlMs(timeoutMs: number): number {
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      timeoutMs + CAPABILITY_EXPIRY_MARGIN_MS
    );
  }

  private isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
  }

  private appendDiagnostic(existing: string, diagnostic: string): string {
    return existing ? `${existing}\n${diagnostic}` : diagnostic;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private redactToken(value: string, token: string | null): string {
    if (!token || token.length === 0) {
      return value;
    }
    return value.split(token).join('[REDACTED]');
  }
}
