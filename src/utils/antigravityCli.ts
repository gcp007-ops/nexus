import { Platform, Vault } from 'obsidian';
import { getPrimaryServerKey } from '../constants/branding';
import { resolveDesktopBinaryPath } from './binaryDiscovery';
import { getConnectorPath, getVaultBasePath } from './cliPathUtils';
import { desktopRequire } from './desktopRequire';

export const ANTIGRAVITY_CLI_DEFAULT_PRINT_TIMEOUT = '5m';
export const ANTIGRAVITY_CLI_LOCAL_AUTH_SENTINEL = 'gemini-cli-local-auth';
const ANTIGRAVITY_MCP_TIMEOUT_MS = 600000;

export interface AntigravityCliRuntime {
  agyPath: string | null;
  nodePath: string | null;
  connectorPath: string | null;
  vaultPath: string | null;
  serverKey: string;
  mcpConfigPath: string;
  authTokenPath: string;
}

type AntigravityDesktopModules = {
  'node:fs': typeof import('node:fs');
  'node:fs/promises': typeof import('node:fs/promises');
  'node:os': typeof import('node:os');
  'node:path': typeof import('node:path');
};

function loadDesktopModule<TModuleName extends keyof AntigravityDesktopModules>(
  moduleName: TModuleName
): AntigravityDesktopModules[TModuleName] {
  return desktopRequire<AntigravityDesktopModules[TModuleName]>(moduleName);
}

export function resolveAntigravityCliRuntime(vault: Vault, homeDir?: string): AntigravityCliRuntime {
  const vaultPath = getVaultBasePath(vault);

  return {
    agyPath: resolveDesktopBinaryPath('agy'),
    nodePath: resolveDesktopBinaryPath('node'),
    connectorPath: getConnectorPath(vaultPath, vault.configDir),
    vaultPath,
    serverKey: getPrimaryServerKey(vault.getName()),
    mcpConfigPath: getAntigravityMcpConfigPath(homeDir),
    authTokenPath: getAntigravityAuthTokenPath(homeDir),
  };
}

export function getAntigravityMcpConfigPath(homeDir?: string): string {
  const osMod = loadDesktopModule('node:os');
  const pathMod = loadDesktopModule('node:path');
  return pathMod.join(homeDir || osMod.homedir(), '.gemini', 'config', 'mcp_config.json');
}

export function getAntigravityAuthTokenPath(homeDir?: string): string {
  const osMod = loadDesktopModule('node:os');
  const pathMod = loadDesktopModule('node:path');
  return pathMod.join(homeDir || osMod.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

export function hasReadableAntigravityAuthToken(authTokenPath?: string): boolean {
  if (!Platform.isDesktop) {
    return false;
  }

  const fs = loadDesktopModule('node:fs');
  const tokenPath = authTokenPath || getAntigravityAuthTokenPath();

  try {
    fs.accessSync(tokenPath, fs.constants.R_OK);
    const stat = fs.statSync(tokenPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function buildAntigravityCliEnv(nodePath?: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_GENAI_USE_VERTEXAI;
  delete env.GOOGLE_CLOUD_PROJECT;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;

  if (nodePath) {
    const pathMod = loadDesktopModule('node:path');
    const separator = process.platform === 'win32' ? ';' : ':';
    env.PATH = pathMod.dirname(nodePath) + separator + (env.PATH || '');
  }

  return env;
}

export async function ensureAntigravityMcpConfig(runtime: AntigravityCliRuntime): Promise<void> {
  if (!runtime.nodePath) {
    throw new Error('Node.js was not found on PATH.');
  }
  if (!runtime.connectorPath) {
    throw new Error('Nexus connector.js was not found for this vault.');
  }
  if (!runtime.vaultPath) {
    throw new Error('Vault filesystem path is unavailable.');
  }

  const fsPromises = loadDesktopModule('node:fs/promises');
  const pathMod = loadDesktopModule('node:path');
  const configPath = runtime.mcpConfigPath;
  const configDir = pathMod.dirname(configPath);

  await fsPromises.mkdir(configDir, { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(configPath, 'utf8');
    config = parseMcpConfig(raw, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const existingServers = isRecord(config.mcpServers)
    ? config.mcpServers as Record<string, unknown>
    : {};

  config.mcpServers = {
    ...existingServers,
    [runtime.serverKey]: {
      command: runtime.nodePath,
      args: [runtime.connectorPath],
      cwd: runtime.vaultPath,
      timeout: ANTIGRAVITY_MCP_TIMEOUT_MS,
    },
  };

  const tempPath = pathMod.join(configDir, `mcp_config.json.tmp-${process.pid}-${Date.now()}`);
  await fsPromises.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fsPromises.rename(tempPath, configPath);
}

function parseMcpConfig(raw: string, configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('top-level value is not an object');
    }

    if (!isValidMcpConfig(parsed)) {
      throw new Error('mcpServers must be a JSON object when present');
    }

    return parsed;
  } catch (error) {
    throw new Error(`Invalid mcp_config.json at ${configPath}: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMcpConfig(config: Record<string, unknown>): boolean {
  if (!('mcpServers' in config)) {
    return true;
  }

  return isRecord(config.mcpServers);
}
