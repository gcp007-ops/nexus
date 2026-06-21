import { GoogleGeminiCliAdapter } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter';
import { normalizeGeminiCliModelForAgy } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliModels';

type VaultLike = {
  getName: () => string;
};

jest.mock('../../src/utils/cliProcessRunner', () => ({
  runCliProcess: jest.fn()
}));

jest.mock('../../src/utils/antigravityCli', () => ({
  ANTIGRAVITY_CLI_DEFAULT_PRINT_TIMEOUT: '60s',
  ANTIGRAVITY_CLI_PROCESS_TIMEOUT_MS: 75000,
  resolveAntigravityCliRuntime: jest.fn(() => ({
    agyPath: '/mock/bin/agy',
    nodePath: '/mock/bin/node',
    connectorPath: '/mock/connector.js',
    vaultPath: '/mock/vault',
    serverKey: 'nexus-test-vault',
    mcpConfigPath: '/mock/home/.gemini/config/mcp_config.json',
    authTokenPath: '/mock/home/.gemini/antigravity-cli/antigravity-oauth-token'
  })),
  buildAntigravityCliEnv: jest.fn((nodePath: string) => ({
    PATH: `/mock/bin:${nodePath}`
  })),
  ensureAntigravityMcpConfig: jest.fn().mockResolvedValue(undefined)
}));

describe('GoogleGeminiCliAdapter', () => {
  const { runCliProcess } = jest.requireMock('../../src/utils/cliProcessRunner') as {
    runCliProcess: jest.Mock;
  };

  let adapter: GoogleGeminiCliAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new GoogleGeminiCliAdapter({
      getName: () => 'Test Vault'
    } as VaultLike);
  });

  it('runs AGY with prompt on stdin and no Gemini CLI output-format flag', async () => {
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    let capturedOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdinText?: string; timeoutMs?: number } | undefined;

    runCliProcess.mockImplementation((command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedOptions = options;

      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({
          stdout: 'AGY output',
          stderr: '',
          exitCode: 0
        })
      };
    });

    const response = await adapter.generateUncached('Summarize the regression', {
      systemPrompt: 'Use the MCP tools if needed.',
      model: 'Gemini 3.1 Pro (High)'
    });

    expect(capturedCommand).toBe('/mock/bin/agy');
    expect(capturedArgs).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '60s',
      '--model',
      'Gemini 3.1 Pro (High)'
    ]);
    expect(capturedArgs).not.toContain('--output-format');
    expect(capturedOptions?.cwd).toBe('/mock/vault');
    expect(capturedOptions?.timeoutMs).toBe(75000);
    expect(capturedOptions?.stdinText).toBe(
      'System instructions:\nUse the MCP tools if needed.\n\nUser request:\nSummarize the regression'
    );
    expect(response.text).toBe('AGY output');
    expect(response.metadata).toEqual(expect.objectContaining({
      localCli: true,
      runtime: 'agy',
      outputFormat: 'text-or-json'
    }));
  });

  it('normalizes stale saved Gemini CLI model ids before invoking AGY', async () => {
    let capturedArgs: string[] = [];
    runCliProcess.mockImplementation((_command, args) => {
      capturedArgs = args;
      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 })
      };
    });

    await adapter.generateUncached('Prompt', { model: 'gemini-3-flash-preview' });

    expect(capturedArgs).toContain('Gemini 3.5 Flash (Medium)');
    expect(capturedArgs).not.toContain('gemini-3-flash-preview');
  });

  it('parses JSON-shaped AGY output when the response is structured', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: JSON.stringify({ response: 'Structured AGY output' }),
        stderr: '',
        exitCode: 0
      })
    });

    const response = await adapter.generateUncached('Return JSON');

    expect(response.text).toBe('Structured AGY output');
  });

  it('fails clearly when AGY is missing and never attempts gemini', async () => {
    const { resolveAntigravityCliRuntime } = jest.requireMock('../../src/utils/antigravityCli') as {
      resolveAntigravityCliRuntime: jest.Mock;
    };
    resolveAntigravityCliRuntime.mockReturnValueOnce({
      agyPath: null,
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      serverKey: 'nexus-test-vault',
      mcpConfigPath: '/mock/home/.gemini/config/mcp_config.json',
      authTokenPath: '/mock/home/.gemini/antigravity-cli/antigravity-oauth-token',
    });

    await expect(adapter.generateUncached('Prompt')).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'CONFIGURATION_ERROR',
      message: expect.stringMatching(/Antigravity CLI.*not found/i)
    });
    expect(runCliProcess).not.toHaveBeenCalled();
  });

  it('parses CLI output with leading logs before the final JSON block', async () => {
    let capturedCommand = '';
    let capturedArgs: string[] = [];

    runCliProcess.mockImplementation((command, args) => {
      capturedCommand = command;
      capturedArgs = args;

      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({
          stdout: [
            'Loaded cached credentials.',
            'Attempt 2 failed with status 429. Retrying with backoff...',
            '{',
            '  "response": "OK",',
            '  "stats": {',
            '    "models": {',
            '      "gemini-3.1-flash-lite-preview": {',
            '        "tokens": {',
            '          "prompt": 8045,',
            '          "candidates": 1,',
            '          "total": 8046',
            '        }',
            '      }',
            '    }',
            '  }',
            '}'
          ].join('\n'),
          stderr: '',
          exitCode: 0
        })
      };
    });

    const response = await adapter.generateUncached('Reply with OK only.', {
      model: 'gemini-3.1-flash-lite-preview'
    });

    expect(capturedCommand).toBe('/mock/bin/agy');
    expect(capturedArgs).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '60s',
      '--model',
      'Gemini 3.5 Flash (Medium)'
    ]);
    expect(response.text).toBe('OK');
    expect(response.usage).toEqual({
      promptTokens: 8045,
      completionTokens: 1,
      totalTokens: 8046
    });
  });

  it('lists only AGY-backed Gemini models under the legacy provider id', async () => {
    const models = await adapter.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)'
    ]);
    expect(models.map((model) => model.id)).not.toContain('gemini-3-flash-preview');
    expect(models.map((model) => model.id)).not.toContain('gemini-3.1-flash-lite-preview');
  });

  it('normalizes legacy Gemini CLI model ids to the AGY default', () => {
    expect(normalizeGeminiCliModelForAgy('gemini-3-flash-preview')).toBe('Gemini 3.5 Flash (Medium)');
    expect(normalizeGeminiCliModelForAgy('gemini-3.1-flash-lite-preview')).toBe('Gemini 3.5 Flash (Medium)');
    expect(normalizeGeminiCliModelForAgy('Gemini 3.1 Pro (High)')).toBe('Gemini 3.1 Pro (High)');
    expect(normalizeGeminiCliModelForAgy(undefined)).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('maps oversized CLI startup failures to REQUEST_TOO_LARGE', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '',
        stderr: 'spawn E2BIG',
        exitCode: null,
        errorCode: 'E2BIG'
      })
    });

    await expect(adapter.generateUncached('A'.repeat(100_000))).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'REQUEST_TOO_LARGE'
    });
  });

  it('maps AGY process timeouts to PROVIDER_TIMEOUT', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '',
        stderr: 'CLI process timed out after 75000ms.',
        exitCode: null,
        errorCode: 'ETIMEDOUT'
      })
    });

    await expect(adapter.generateUncached('Prompt')).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'PROVIDER_TIMEOUT',
      message: expect.stringMatching(/Antigravity CLI timed out/i)
    });
  });

  it('maps empty successful AGY output to PROVIDER_TIMEOUT', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0
      })
    });

    await expect(adapter.generateUncached('Prompt')).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'PROVIDER_TIMEOUT',
      message: expect.stringMatching(/did not return a final response/i)
    });
  });
});
