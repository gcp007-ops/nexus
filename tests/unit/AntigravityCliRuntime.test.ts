jest.mock('obsidian', () => ({
  Platform: { isDesktop: true },
}));

jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: jest.fn((moduleName: string) => require(moduleName)),
}));

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildAntigravityCliEnv,
  ensureAntigravityMcpConfig,
  getAntigravityAuthTokenPath,
  getAntigravityMcpConfigPath,
  hasReadableAntigravityAuthToken,
  resolveAntigravityCliRuntime,
  type AntigravityCliRuntime,
} from '../../src/utils/antigravityCli';

jest.mock('../../src/utils/binaryDiscovery', () => ({
  resolveDesktopBinaryPath: jest.fn((binary: string) => `/mock/bin/${binary}`)
}));

jest.mock('../../src/utils/cliPathUtils', () => ({
  getVaultBasePath: jest.fn(() => '/mock/vault'),
  getConnectorPath: jest.fn(() => '/mock/vault/.obsidian/plugins/nexus/connector.js')
}));

jest.mock('../../src/constants/branding', () => ({
  getPrimaryServerKey: jest.fn(() => 'nexus-test-vault')
}));

describe('antigravityCli utilities', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nexus-agy-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempHome, { recursive: true, force: true });
  });

  it('resolves AGY, Node, connector, vault, server key, and MCP config path without resolving gemini', () => {
    const runtime = resolveAntigravityCliRuntime({ getName: () => 'Test Vault' } as never, tempHome);

    expect(runtime).toEqual({
      agyPath: '/mock/bin/agy',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/vault/.obsidian/plugins/nexus/connector.js',
      vaultPath: '/mock/vault',
      serverKey: 'nexus-test-vault',
      mcpConfigPath: path.join(tempHome, '.gemini', 'config', 'mcp_config.json'),
      authTokenPath: path.join(tempHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    });
  });

  it('builds canonical AGY config and auth token paths', () => {
    expect(getAntigravityMcpConfigPath(tempHome)).toBe(
      path.join(tempHome, '.gemini', 'config', 'mcp_config.json')
    );
    expect(getAntigravityAuthTokenPath(tempHome)).toBe(
      path.join(tempHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    );
  });

  it('checks auth token readability without reading token contents into metadata', async () => {
    const tokenPath = getAntigravityAuthTokenPath(tempHome);
    expect(hasReadableAntigravityAuthToken(tokenPath)).toBe(false);

    await fsPromises.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsPromises.writeFile(tokenPath, 'opaque-token-value', 'utf8');

    expect(hasReadableAntigravityAuthToken(tokenPath)).toBe(true);
  });

  it('prepends Node directory to PATH and clears inherited Google API env vars', () => {
    process.env.GEMINI_API_KEY = 'leaked';
    process.env.GOOGLE_API_KEY = 'leaked';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'leaked';

    const env = buildAntigravityCliEnv('/opt/homebrew/bin/node');

    expect(env.PATH?.startsWith('/opt/homebrew/bin')).toBe(true);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('merges the Nexus MCP entry while preserving existing AGY config', async () => {
    const runtime: AntigravityCliRuntime = {
      agyPath: '/mock/bin/agy',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      serverKey: 'nexus-test-vault',
      mcpConfigPath: getAntigravityMcpConfigPath(tempHome),
      authTokenPath: getAntigravityAuthTokenPath(tempHome),
    };

    await fsPromises.mkdir(path.dirname(runtime.mcpConfigPath), { recursive: true });
    await fsPromises.writeFile(runtime.mcpConfigPath, JSON.stringify({
      unrelatedTopLevel: true,
      mcpServers: {
        notebooks: {
          command: 'node',
          args: ['/existing/notebooks.js']
        }
      }
    }, null, 2), 'utf8');

    await ensureAntigravityMcpConfig(runtime);

    const merged = JSON.parse(await fsPromises.readFile(runtime.mcpConfigPath, 'utf8'));
    expect(merged.unrelatedTopLevel).toBe(true);
    expect(merged.mcpServers.notebooks.args).toEqual(['/existing/notebooks.js']);
    expect(merged.mcpServers['nexus-test-vault']).toEqual({
      command: '/mock/bin/node',
      args: ['/mock/connector.js'],
      cwd: '/mock/vault',
      timeout: 600000
    });
  });

  it('refuses to overwrite malformed MCP config', async () => {
    const runtime: AntigravityCliRuntime = {
      agyPath: '/mock/bin/agy',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      serverKey: 'nexus-test-vault',
      mcpConfigPath: getAntigravityMcpConfigPath(tempHome),
      authTokenPath: getAntigravityAuthTokenPath(tempHome),
    };

    await fsPromises.mkdir(path.dirname(runtime.mcpConfigPath), { recursive: true });
    await fsPromises.writeFile(runtime.mcpConfigPath, '{not-json', 'utf8');

    await expect(ensureAntigravityMcpConfig(runtime)).rejects.toThrow(/invalid mcp_config\.json/i);
    expect(fs.readFileSync(runtime.mcpConfigPath, 'utf8')).toBe('{not-json');
  });
});
