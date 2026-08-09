import type { WorkflowCapabilityProfile } from '../../database/types/workspace/WorkspaceTypes';

export interface AgentCapabilityGrant {
  readonly runId: string;
  readonly profile: WorkflowCapabilityProfile;
  readonly expiresAt: number;
}

export interface IssuedAgentCapability {
  token: string;
  grant: AgentCapabilityGrant;
}

type TokenFactory = () => string;
type Clock = () => number;

const VAULT_READONLY_TOOLS = new Set([
  'contentManager:read',
  'storageManager:list',
  'searchManager:content',
  'searchManager:directory',
  'searchManager:memory',
  'memoryManager:listStates',
  'memoryManager:loadState',
  'memoryManager:listWorkspaces',
  'memoryManager:loadWorkspace',
  'taskManager:listProjects',
  'taskManager:list',
  'taskManager:query',
  'taskManager:open',
  'canvasManager:read',
  'canvasManager:list'
]);

function createSecureToken(): string {
  const cryptoApi = window.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error('Secure randomness is unavailable for agent capability issuance');
  }
  return cryptoApi.randomUUID();
}

export class AgentCapabilityPolicyService {
  private readonly grantsByToken = new Map<string, AgentCapabilityGrant>();

  constructor(
    private readonly tokenFactory: TokenFactory = createSecureToken,
    private readonly now: Clock = () => Date.now()
  ) {}

  issue(
    runId: string,
    profile: WorkflowCapabilityProfile,
    ttlMs = 60 * 60_000
  ): IssuedAgentCapability {
    if (runId.trim().length === 0) {
      throw new Error('runId is required for agent capability issuance');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Agent capability ttlMs must be a positive finite number');
    }

    const token = this.createUniqueToken();
    const grant = Object.freeze({
      runId,
      profile,
      expiresAt: this.now() + ttlMs
    });
    this.grantsByToken.set(token, grant);
    return { token, grant };
  }

  resolve(token: string): AgentCapabilityGrant | undefined {
    const grant = this.grantsByToken.get(token);
    if (!grant) {
      return undefined;
    }
    if (this.now() >= grant.expiresAt) {
      this.grantsByToken.delete(token);
      return undefined;
    }
    return grant;
  }

  revoke(token: string): void {
    this.grantsByToken.delete(token);
  }

  allows(grant: AgentCapabilityGrant, agent: string, tool: string): boolean {
    if (this.now() >= grant.expiresAt || grant.profile !== 'vault-readonly') {
      return false;
    }
    return VAULT_READONLY_TOOLS.has(`${agent}:${tool}`);
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const token = this.tokenFactory();
      if (token.length > 0 && !this.grantsByToken.has(token)) {
        return token;
      }
    }
    throw new Error('Unable to issue a unique agent capability token');
  }
}

export const agentCapabilityPolicyService = new AgentCapabilityPolicyService();
