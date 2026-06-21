jest.mock('obsidian', () => ({
  App: class App {
    vault = { getName: () => 'Test Vault' };
  },
  Platform: { isDesktop: true },
}));

jest.mock('../../src/utils/antigravityCli', () => ({
  ANTIGRAVITY_CLI_LOCAL_AUTH_SENTINEL: 'gemini-cli-local-auth',
  resolveAntigravityCliRuntime: jest.fn(() => ({
    agyPath: '/mock/bin/agy',
    nodePath: '/mock/bin/node',
    connectorPath: '/mock/connector.js',
    vaultPath: '/mock/vault',
    serverKey: 'nexus-test-vault',
    mcpConfigPath: '/mock/home/.gemini/config/mcp_config.json',
    authTokenPath: '/mock/home/.gemini/antigravity-cli/antigravity-oauth-token',
  })),
  hasReadableAntigravityAuthToken: jest.fn(() => true),
  ensureAntigravityMcpConfig: jest.fn().mockResolvedValue(undefined),
}));

import { App, Platform } from 'obsidian';
import { GeminiCliAuthService } from '../../src/services/external/GeminiCliAuthService';

describe('GeminiCliAuthService AGY mode', () => {
  const antigravity = jest.requireMock('../../src/utils/antigravityCli') as {
    resolveAntigravityCliRuntime: jest.Mock;
    hasReadableAntigravityAuthToken: jest.Mock;
    ensureAntigravityMcpConfig: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.isDesktop = true;
  });

  it('reports AGY connected and ensures MCP config during checkAuth', async () => {
    const service = new GeminiCliAuthService(new App());

    const result = await service.checkAuth();

    expect(result).toEqual({
      success: true,
      apiKey: 'gemini-cli-local-auth',
      metadata: {
        authMethod: 'agy-oauth',
        runtime: 'agy',
        agyPath: '/mock/bin/agy',
      },
    });
    expect(antigravity.ensureAntigravityMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('does not call gemini and returns setup guidance when agy is missing', async () => {
    antigravity.resolveAntigravityCliRuntime.mockReturnValueOnce({
      agyPath: null,
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      serverKey: 'nexus-test-vault',
      mcpConfigPath: '/mock/home/.gemini/config/mcp_config.json',
      authTokenPath: '/mock/home/.gemini/antigravity-cli/antigravity-oauth-token',
    });
    const service = new GeminiCliAuthService(new App());

    const result = await service.checkAuth();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Antigravity CLI.*not found/i);
    expect(result.error).toMatch(/agy/i);
  });

  it('returns login guidance when the AGY auth token is absent', async () => {
    antigravity.hasReadableAntigravityAuthToken.mockReturnValueOnce(false);
    const service = new GeminiCliAuthService(new App());

    const result = await service.checkAuth();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/run `agy`/i);
  });

  it('returns MCP setup errors without marking the provider connected', async () => {
    antigravity.ensureAntigravityMcpConfig.mockRejectedValueOnce(new Error('Invalid mcp_config.json at /mock/path'));
    const service = new GeminiCliAuthService(new App());

    const result = await service.checkAuth();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid mcp_config.json at /mock/path');
  });
});
