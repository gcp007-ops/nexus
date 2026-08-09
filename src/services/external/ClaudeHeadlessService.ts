import { App, FileSystemAdapter, Plugin, Platform } from 'obsidian';
import { getPrimaryServerKey } from '../../constants/branding';
import { resolveDesktopBinaryPath } from '../../utils/binaryDiscovery';
import { spawnDesktopProcess, type DesktopChildProcess } from '../../utils/desktopProcess';

const MAX_SAFE_WINDOWS_ARGV_CHARS = 24_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

type ClaudeHeadlessDesktopModuleMap = {
    'fs/promises': typeof import('fs/promises');
    path: typeof import('path');
    os: typeof import('os');
    child_process: typeof import('child_process');
};

export interface ClaudeHeadlessPreflightResult {
    claudePath: string | null;
    nodePath: string | null;
    connectorPath: string | null;
    vaultPath: string | null;
    isAuthenticated: boolean;
    authStatusText: string;
}

export interface ClaudeHeadlessRunOptions {
    prompt: string;
    model?: string;
    maxTurns?: number;
    /** @deprecated Retained for legacy callers. Permission bypass is ignored. */
    bypassPermissions?: boolean;
}

export interface ClaudeHeadlessRunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    commandLine: string;
    preflight: ClaudeHeadlessPreflightResult;
}

export interface ClaudeHeadlessWorkflowRuntime {
    claudePath: string | null;
    nodePath: string | null;
    vaultPath: string | null;
}

export interface ClaudeHeadlessProcessOptions {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdinText?: string;
    maxOutputChars?: number;
    terminationGraceMs?: number;
}

export interface ClaudeHeadlessProcessResult {
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    exitCode: number | null;
    errorCode?: string;
}

export interface ClaudeHeadlessProcessHandle {
    result: Promise<ClaudeHeadlessProcessResult>;
    terminateTree(): Promise<void>;
}

export interface ClaudeHeadlessServiceDependencies {
    signalProcessTree?: (
        child: DesktopChildProcess,
        signal: NodeJS.Signals
    ) => Promise<void>;
}

export class ClaudeHeadlessService {
    constructor(
        private app: App,
        private plugin: Plugin,
        private dependencies: ClaudeHeadlessServiceDependencies = {}
    ) {}

    getWorkflowRuntime(): ClaudeHeadlessWorkflowRuntime {
        return {
            claudePath: resolveDesktopBinaryPath('claude'),
            nodePath: resolveDesktopBinaryPath('node'),
            vaultPath: this.getVaultBasePath()
        };
    }

    startAuthStatusProcess(
        claudePath: string,
        cwd?: string
    ): ClaudeHeadlessProcessHandle {
        return this.startProcess({
            command: claudePath,
            args: ['auth', 'status', '--text'],
            cwd,
            env: this.buildClaudeEnv()
        });
    }

    async getPreflight(): Promise<ClaudeHeadlessPreflightResult> {
        const claudePath = resolveDesktopBinaryPath('claude');
        const nodePath = resolveDesktopBinaryPath('node');
        const connectorPath = this.getConnectorPath();
        const vaultPath = this.getVaultBasePath();

        if (!claudePath) {
            return {
                claudePath: null,
                nodePath,
                connectorPath,
                vaultPath,
                isAuthenticated: false,
                authStatusText: 'Claude Code was not found on PATH.'
            };
        }

        const authResult = await this.startAuthStatusProcess(
            claudePath,
            vaultPath ?? undefined
        ).result;
        const authStatusText = [authResult.stdout.trim(), authResult.stderr.trim()]
            .filter(Boolean)
            .join('\n')
            .trim();

        return {
            claudePath,
            nodePath,
            connectorPath,
            vaultPath,
            isAuthenticated: authResult.exitCode === 0,
            authStatusText: authStatusText || 'Claude auth status is unavailable.'
        };
    }

    async run(options: ClaudeHeadlessRunOptions): Promise<ClaudeHeadlessRunResult> {
        const startedAt = Date.now();
        const preflight = await this.getPreflight();
        const prompt = options.prompt.trim();

        if (!Platform.isDesktop) {
            return this.buildFailureResult('Claude headless mode is only available on desktop.', preflight, startedAt);
        }

        if (!prompt) {
            return this.buildFailureResult('Prompt is required.', preflight, startedAt);
        }

        if (!preflight.claudePath) {
            return this.buildFailureResult('Claude Code was not found on PATH.', preflight, startedAt);
        }

        if (!preflight.nodePath) {
            return this.buildFailureResult('Node.js was not found on PATH.', preflight, startedAt);
        }

        if (!preflight.connectorPath) {
            return this.buildFailureResult('connector.js could not be resolved for this vault.', preflight, startedAt);
        }

        if (!preflight.vaultPath) {
            return this.buildFailureResult('Vault base path is unavailable. This experiment requires the desktop filesystem adapter.', preflight, startedAt);
        }

        const fsPromises = this.loadDesktopModule('fs/promises');
        const pathMod = this.loadDesktopModule('path');
        const osMod = this.loadDesktopModule('os');

        const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-claude-headless-'));
        const mcpConfigPath = pathMod.join(tempDir, 'mcp.json');

        try {
            await fsPromises.writeFile(
                mcpConfigPath,
                JSON.stringify(this.buildMcpConfig(preflight.nodePath, preflight.connectorPath), null, 2),
                'utf8'
            );

            const args = [
                '-p',
                '--strict-mcp-config',
                '--mcp-config',
                mcpConfigPath,
                '--tools',
                '',
                '--disable-slash-commands',
                '--output-format',
                'text',
                '--max-turns',
                String(Math.max(1, options.maxTurns ?? 8))
            ];

            const model = options.model?.trim();
            if (model) {
                args.push('--model', model);
            }

            this.assertSafeWindowsArgv(preflight.claudePath, args);

            const processResult = await this.runProcess(
                preflight.claudePath,
                args,
                preflight.vaultPath,
                this.buildClaudeEnv(),
                prompt
            );

            const transportError = this.mapTransportError(processResult);
            return {
                success: processResult.exitCode === 0 && !transportError,
                stdout: processResult.stdout,
                stderr: transportError || processResult.stderr,
                exitCode: processResult.exitCode,
                durationMs: Date.now() - startedAt,
                commandLine: this.formatCommand(preflight.claudePath, args),
                preflight
            };
        } catch (error) {
            return this.buildFailureResult((error as Error).message, preflight, startedAt);
        } finally {
            try {
                await fsPromises.rm(tempDir, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup only.
            }
        }
    }

    private buildMcpConfig(nodePath: string, connectorPath: string): Record<string, unknown> {
        const serverKey = getPrimaryServerKey(this.app.vault.getName());
        return {
            mcpServers: {
                [serverKey]: {
                    type: 'stdio',
                    command: nodePath,
                    args: [connectorPath]
                }
            }
        };
    }

    private buildFailureResult(message: string, preflight: ClaudeHeadlessPreflightResult, startedAt: number): ClaudeHeadlessRunResult {
        return {
            success: false,
            stdout: '',
            stderr: message,
            exitCode: null,
            durationMs: Date.now() - startedAt,
            commandLine: '',
            preflight
        };
    }

    buildClaudeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // Favor the user's local Claude subscription login instead of any API key
        // accidentally inherited from the Obsidian/Electron environment.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;

        // A retained Electron process can outlive a prior workflow child. Never
        // let one run inherit another run's ephemeral capability by accident.
        delete env.NEXUS_AGENT_RUN_TOKEN;
        delete env.NEXUS_MCP_SOCKET_PATH;

        Object.assign(env, extra);

        // Workflow callers may add the explicit Nexus capability variables, but
        // the Claude CLI must always use its local subscription authentication.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;

        return env;
    }

    startProcess(options: ClaudeHeadlessProcessOptions): ClaudeHeadlessProcessHandle {
        const childProcess = this.loadDesktopModule('child_process');
        const maxOutputChars = Number.isFinite(options.maxOutputChars) && (options.maxOutputChars ?? 0) > 0
            ? Math.floor(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)
            : DEFAULT_MAX_OUTPUT_CHARS;
        const terminationGraceMs = Number.isFinite(options.terminationGraceMs) && (options.terminationGraceMs ?? -1) >= 0
            ? Math.floor(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS)
            : DEFAULT_TERMINATION_GRACE_MS;
        const stdio: ['pipe', 'pipe', 'pipe'] | ['ignore', 'pipe', 'pipe'] = options.stdinText !== undefined
            ? ['pipe', 'pipe', 'pipe']
            : ['ignore', 'pipe', 'pipe'];

        let child: DesktopChildProcess;
        try {
            child = spawnDesktopProcess(childProcess, options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                stdio,
                detached: !Platform.isWin
            });
        } catch (error) {
            const processError = error as NodeJS.ErrnoException;
            return {
                result: Promise.resolve({
                    stdout: '',
                    stderr: processError.message,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    exitCode: null,
                    errorCode: processError.code
                }),
                terminateTree: () => Promise.resolve()
            };
        }

        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let chosenResult: ClaudeHeadlessProcessResult | null = null;
        let resultSettled = false;
        let processClosed = false;
        let resolveResult!: (value: ClaudeHeadlessProcessResult) => void;
        let resolveClosed!: () => void;
        let stdinErrorHandler: ((error: NodeJS.ErrnoException) => void) | null = null;
        let terminationPromise: Promise<void> | null = null;

        const result = new Promise<ClaudeHeadlessProcessResult>((resolve) => {
            resolveResult = resolve;
        });
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });

        const appendBounded = (current: string, chunk: Buffer | string): { value: string; truncated: boolean } => {
            const text = chunk.toString();
            const remaining = Math.max(0, maxOutputChars - current.length);
            if (text.length <= remaining) {
                return { value: current + text, truncated: false };
            }
            return {
                value: current + text.slice(0, remaining),
                truncated: true
            };
        };

        const cleanupListeners = () => {
            child.off('error', handleProcessError);
            child.off('close', handleProcessClose);
            child.stdout?.off('data', handleStdout);
            child.stderr?.off('data', handleStderr);
            if (stdinErrorHandler) {
                child.stdin?.off('error', stdinErrorHandler);
                stdinErrorHandler = null;
            }
        };

        const finalize = () => {
            if (resultSettled || !chosenResult) {
                return;
            }
            resultSettled = true;
            cleanupListeners();
            resolveResult(chosenResult);
        };

        const chooseResult = (value: ClaudeHeadlessProcessResult) => {
            chosenResult ??= value;
        };

        const markClosed = () => {
            if (processClosed) {
                return;
            }
            processClosed = true;
            resolveClosed();
        };

        const terminateTree = (): Promise<void> => {
            if (terminationPromise) {
                return terminationPromise;
            }
            if (processClosed) {
                return Promise.resolve();
            }

            terminationPromise = (async () => {
                await this.signalProcessTree(child, 'SIGTERM');
                const closedDuringGrace = await this.waitForClose(closed, terminationGraceMs);
                if (!closedDuringGrace) {
                    await this.signalProcessTree(child, 'SIGKILL');
                    await closed;
                }
            })();
            return terminationPromise;
        };

        const terminateAfterLocalFailure = () => {
            if (child.pid === undefined || child.pid === null) {
                markClosed();
                finalize();
                return;
            }
            void terminateTree().catch(() => {
                // Keep the result pending rather than claim termination while the process may live.
            });
        };

        function handleStdout(chunk: Buffer | string): void {
            const appended = appendBounded(stdout, chunk);
            stdout = appended.value;
            stdoutTruncated ||= appended.truncated;
        }

        function handleStderr(chunk: Buffer | string): void {
            const appended = appendBounded(stderr, chunk);
            stderr = appended.value;
            stderrTruncated ||= appended.truncated;
        }

        function handleProcessError(error: NodeJS.ErrnoException): void {
            chooseResult({
                stdout,
                stderr: stderr ? `${stderr}\n${error.message}` : error.message,
                stdoutTruncated,
                stderrTruncated,
                exitCode: null,
                errorCode: error.code
            });
            terminateAfterLocalFailure();
        }

        function handleProcessClose(exitCode: number | null): void {
            markClosed();
            chooseResult({
                stdout,
                stderr,
                stdoutTruncated,
                stderrTruncated,
                exitCode
            });
            finalize();
        }

        child.on('error', handleProcessError);
        child.on('close', handleProcessClose);

        if (!child.stdout || !child.stderr || (options.stdinText !== undefined && !child.stdin)) {
            chooseResult({
                stdout,
                stderr: 'Failed to capture Claude Code process output.',
                stdoutTruncated,
                stderrTruncated,
                exitCode: null
            });
            terminateAfterLocalFailure();
        } else {
            child.stdout.on('data', handleStdout);
            child.stderr.on('data', handleStderr);

            if (options.stdinText !== undefined && child.stdin) {
                stdinErrorHandler = (error: NodeJS.ErrnoException) => {
                    chooseResult({
                        stdout,
                        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
                        stdoutTruncated,
                        stderrTruncated,
                        exitCode: null,
                        errorCode: error.code
                    });
                    terminateAfterLocalFailure();
                };
                child.stdin.once('error', stdinErrorHandler);
                child.stdin.end(options.stdinText, 'utf8', () => {
                    if (stdinErrorHandler) {
                        child.stdin?.off('error', stdinErrorHandler);
                        stdinErrorHandler = null;
                    }
                });
            }
        }

        return { result, terminateTree };
    }

    private async runProcess(
        command: string,
        args: string[],
        cwd?: string,
        env?: NodeJS.ProcessEnv,
        stdinText?: string
    ): Promise<ClaudeHeadlessProcessResult> {
        return await this.startProcess({ command, args, cwd, env, stdinText }).result;
    }

    private async waitForClose(closed: Promise<void>, graceMs: number): Promise<boolean> {
        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (didClose: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timer);
                resolve(didClose);
            };
            const timer = window.setTimeout(() => finish(false), graceMs);
            void closed.then(() => finish(true));
        });
    }

    private async signalProcessTree(
        child: DesktopChildProcess,
        signal: NodeJS.Signals
    ): Promise<void> {
        if (this.dependencies.signalProcessTree) {
            await this.dependencies.signalProcessTree(child, signal);
            return;
        }

        const pid = child.pid;
        if (pid === undefined || pid === null) {
            child.kill(signal);
            return;
        }

        if (!Platform.isWin) {
            try {
                process.kill(-pid, signal);
            } catch {
                child.kill(signal);
            }
            return;
        }

        const childProcess = this.loadDesktopModule('child_process');
        const args = ['/PID', String(pid), '/T'];
        if (signal === 'SIGKILL') {
            args.push('/F');
        }

        await new Promise<void>((resolve) => {
            const taskkill = childProcess.spawn('taskkill', args, {
                stdio: 'ignore',
                windowsHide: true
            });
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            taskkill.once('error', finish);
            taskkill.once('close', finish);
        });
    }

    private getConnectorPath(): string | null {
        const vaultBasePath = this.getVaultBasePath();
        if (!vaultBasePath) {
            return null;
        }

        const pathMod = this.loadDesktopModule('path');
        const manifestDir = this.plugin.manifest.dir;
        const pluginFolderName = manifestDir ? manifestDir.split('/').pop() || manifestDir : '';

        if (!pluginFolderName) {
            return null;
        }

        return pathMod.join(vaultBasePath, this.app.vault.configDir, 'plugins', pluginFolderName, 'connector.js');
    }

    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            return adapter.getBasePath();
        }

        return null;
    }

    private loadDesktopModule<TModuleName extends keyof ClaudeHeadlessDesktopModuleMap>(
        moduleName: TModuleName
    ): ClaudeHeadlessDesktopModuleMap[TModuleName] {
        if (!Platform.isDesktop) {
            throw new Error(`${moduleName} is only available on desktop.`);
        }

        const maybeRequire = (window.activeWindow as Window & {
            require?: (moduleId: string) => unknown;
        }).require;

        if (typeof maybeRequire !== 'function') {
            throw new Error('Desktop module loader is unavailable.');
        }

        return maybeRequire(moduleName) as ClaudeHeadlessDesktopModuleMap[TModuleName];
    }

    private formatCommand(command: string, args: string[]): string {
        const parts = [command, ...args].map((part) => {
            if (/[\s"]/u.test(part)) {
                return `"${part.replace(/"/g, '\\"')}"`;
            }
            return part;
        });

        return parts.join(' ');
    }

    private assertSafeWindowsArgv(command: string, args: string[]): void {
        if (!Platform.isWin) {
            return;
        }

        const totalChars = [command, ...args].reduce((sum, part) => sum + part.length + 1, 0);
        if (totalChars > MAX_SAFE_WINDOWS_ARGV_CHARS) {
            throw new Error('Claude headless command is too large for Windows argv transport. Shorten the prompt or attached context and try again.');
        }
    }

    private mapTransportError(result: ClaudeHeadlessProcessResult): string | null {
        if (result.errorCode === 'E2BIG' || result.errorCode === 'ENAMETOOLONG') {
            return 'Claude headless command is too large for local CLI transport. Shorten the prompt or attached context and try again.';
        }

        return null;
    }
}
