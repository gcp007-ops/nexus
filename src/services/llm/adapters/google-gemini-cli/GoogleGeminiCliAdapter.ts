/**
 * src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts
 *
 * LLM adapter for the legacy google-gemini-cli provider id.
 * Runtime execution is handled by Google Antigravity CLI (`agy`).
 */
import { Vault } from 'obsidian';
import type { DesktopChildProcess } from '../../../../utils/desktopProcess';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  LLMProviderError,
  TokenUsage
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import {
  GOOGLE_GEMINI_CLI_DEFAULT_MODEL,
  normalizeGeminiCliModelForAgy
} from './GoogleGeminiCliModels';
import { CliProcessResult, runCliProcess } from '../../../../utils/cliProcessRunner';
import {
  ANTIGRAVITY_CLI_DEFAULT_PRINT_TIMEOUT,
  ANTIGRAVITY_CLI_PROCESS_TIMEOUT_MS,
  buildAntigravityCliEnv,
  ensureAntigravityMcpConfig,
  resolveAntigravityCliRuntime
} from '../../../../utils/antigravityCli';

interface GeminiCliJsonResponse {
  response?: string;
  text?: string;
  content?: string;
  output?: string;
  result?: {
    text?: string;
  };
  stats?: {
    models?: Array<Record<string, unknown>>;
    tools?: unknown;
  };
  error?: string | { message?: string };
}

export class GoogleGeminiCliAdapter extends BaseAdapter {
  readonly name = 'google-gemini-cli';
  readonly baseUrl = 'gemini-cli://local';
  private activeProcess: DesktopChildProcess | null = null;

  constructor(private vault: Vault) {
    super('gemini-cli-local-auth', GOOGLE_GEMINI_CLI_DEFAULT_MODEL, 'gemini-cli://local', false);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const runtime = resolveAntigravityCliRuntime(this.vault);
    if (!runtime.agyPath) {
      throw new LLMProviderError('Antigravity CLI (`agy`) was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.nodePath) {
      throw new LLMProviderError('Node.js was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.connectorPath) {
      throw new LLMProviderError('Nexus connector.js was not found for this vault.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.vaultPath) {
      throw new LLMProviderError('Vault filesystem path is unavailable.', this.name, 'CONFIGURATION_ERROR');
    }

    await ensureAntigravityMcpConfig(runtime);

    const combinedPrompt = this.buildPrompt(prompt, options?.systemPrompt);
    const model = normalizeGeminiCliModelForAgy(options?.model || this.currentModel);
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--print-timeout',
      ANTIGRAVITY_CLI_DEFAULT_PRINT_TIMEOUT,
      '--model',
      model
    ];

    const handle = runCliProcess(runtime.agyPath, args, {
      cwd: runtime.vaultPath,
      env: buildAntigravityCliEnv(runtime.nodePath),
      stdinText: combinedPrompt,
      timeoutMs: ANTIGRAVITY_CLI_PROCESS_TIMEOUT_MS
    });
    this.activeProcess = handle.child;
    const result = await handle.result;
    this.activeProcess = null;

    if (result.exitCode !== 0) {
      throw this.mapCliProcessFailure(result);
    }

    const parsed = this.parseOutput(result.stdout);
    const text = parsed ? this.extractText(parsed) : result.stdout.trim();
    const usage = parsed ? this.extractUsageFromStats(parsed) : undefined;

    return this.buildLLMResponse(
      text,
      model,
      usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      {
        localCli: true,
        runtime: 'agy',
        outputFormat: parsed ? 'json' : 'text-or-json',
        toolSummary: parsed?.stats?.tools
      },
      'stop'
    );
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await this.generateUncached(prompt, options);
    yield {
      content: response.text,
      complete: true,
      usage: response.usage
    };
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(ModelRegistry.getProviderModels('google-gemini-cli').map(model => ModelRegistry.toModelInfo(model)));
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 1048576,
      supportedFeatures: ['agy', 'antigravity-cli', 'mcp', 'google-login']
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const model = ModelRegistry.findModel('google-gemini-cli', modelId);
    if (!model) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      rateInputPerMillion: model.inputCostPerMillion,
      rateOutputPerMillion: model.outputCostPerMillion,
      currency: 'USD'
    });
  }

  abort(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  private buildPrompt(prompt: string, systemPrompt?: string): string {
    if (!systemPrompt?.trim()) {
      return prompt;
    }

    return `System instructions:\n${systemPrompt.trim()}\n\nUser request:\n${prompt}`;
  }

  private parseOutput(stdout: string): GeminiCliJsonResponse | null {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as GeminiCliJsonResponse;
    } catch {
      const lastJsonLine = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => line.startsWith('{') && line.endsWith('}'));

      if (!lastJsonLine) {
        return this.parseTrailingJsonBlock(trimmed);
      }

      try {
        return JSON.parse(lastJsonLine) as GeminiCliJsonResponse;
      } catch {
        return this.parseTrailingJsonBlock(trimmed);
      }
    }
  }

  private extractText(parsed: GeminiCliJsonResponse): string {
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.output === 'string') return parsed.output;
    if (typeof parsed.result?.text === 'string') return parsed.result.text;
    return '';
  }

  private extractUsageFromStats(parsed: GeminiCliJsonResponse): TokenUsage | undefined {
    const modelStats = this.extractModelStats(parsed.stats?.models);
    if (!modelStats || typeof modelStats !== 'object') {
      return undefined;
    }

    const tokenStats = this.extractTokenStats(modelStats);
    const promptTokens = this.readNumber(tokenStats, ['prompt', 'promptTokens', 'inputTokens']);
    const completionTokens = this.readNumber(tokenStats, ['candidates', 'candidatesTokens', 'outputTokens', 'completionTokens']);
    const totalTokens = this.readNumber(tokenStats, ['total', 'totalTokens']);

    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return undefined;
    }

    return {
      promptTokens: promptTokens || 0,
      completionTokens: completionTokens || 0,
      totalTokens: totalTokens || ((promptTokens || 0) + (completionTokens || 0))
    };
  }

  private readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }

  private parseTrailingJsonBlock(output: string): GeminiCliJsonResponse | null {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index].trim() !== '{') {
        continue;
      }

      try {
        return JSON.parse(lines.slice(index).join('\n')) as GeminiCliJsonResponse;
      } catch {
        continue;
      }
    }

    return null;
  }

  private extractModelStats(
    modelStats: Record<string, unknown>[] | Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (Array.isArray(modelStats)) {
      const firstEntry = modelStats[0];
      return firstEntry && typeof firstEntry === 'object' ? firstEntry : undefined;
    }

    if (!modelStats || typeof modelStats !== 'object') {
      return undefined;
    }

    const firstEntry = Object.values(modelStats).find(
      (value) => value && typeof value === 'object' && !Array.isArray(value)
    );

    return firstEntry ? firstEntry as Record<string, unknown> : undefined;
  }

  private extractTokenStats(modelStats: Record<string, unknown>): Record<string, unknown> {
    const tokens = modelStats.tokens;
    if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
      return tokens as Record<string, unknown>;
    }

    return modelStats;
  }

  private mapCliProcessFailure(result: CliProcessResult): LLMProviderError {
    if (result.errorCode === 'ENAMETOOLONG' || result.errorCode === 'E2BIG') {
      return new LLMProviderError(
        'Antigravity CLI could not start because the local CLI command was too long for this platform. Reduce attached context files or shorten the prompt and try again.',
        this.name,
        'REQUEST_TOO_LARGE'
      );
    }

    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (result.errorCode === 'ETIMEDOUT' || /timed out waiting for response|timed out after/i.test(output)) {
      return new LLMProviderError(
        'Antigravity CLI timed out before producing a final response. Try a shorter prompt, reduce attached context, or retry with another model.',
        this.name,
        'PROVIDER_TIMEOUT'
      );
    }

    return new LLMProviderError(
      output || `Antigravity CLI exited with status ${result.exitCode ?? 'unknown'}`,
      this.name,
      result.exitCode === null ? 'CONFIGURATION_ERROR' : 'PROVIDER_ERROR'
    );
  }
}
