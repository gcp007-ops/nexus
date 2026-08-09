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

const grantsByExecutionParams = new WeakMap<object, AgentCapabilityGrant>();

/** Bind trusted authority out-of-band so it is not a tool parameter or DTO. */
export function bindAgentCapabilityGrant(
  params: object,
  grant: AgentCapabilityGrant
): void {
  grantsByExecutionParams.set(params, grant);
}

export function getBoundAgentCapabilityGrant(
  params: object
): AgentCapabilityGrant | undefined {
  return grantsByExecutionParams.get(params);
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
  private readonly tokensByGrant = new Map<AgentCapabilityGrant, string>();
  private readonly deniedTokens = new Set<string>();

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
    this.tokensByGrant.set(grant, token);
    return { token, grant };
  }

  resolve(token: string): AgentCapabilityGrant | undefined {
    const grant = this.grantsByToken.get(token);
    if (!grant) {
      return undefined;
    }
    if (this.now() >= grant.expiresAt) {
      this.grantsByToken.delete(token);
      this.tokensByGrant.delete(grant);
      this.deniedTokens.delete(token);
      return undefined;
    }
    return grant;
  }

  revoke(token: string): boolean {
    const grant = this.grantsByToken.get(token);
    const denied = this.deniedTokens.delete(token);
    this.grantsByToken.delete(token);
    if (grant) {
      this.tokensByGrant.delete(grant);
    }
    return denied;
  }

  allows(grant: AgentCapabilityGrant, agent: string, tool: string): boolean {
    const token = this.tokensByGrant.get(grant);
    if (!token || this.grantsByToken.get(token) !== grant) {
      return false;
    }
    if (this.now() >= grant.expiresAt || grant.profile !== 'vault-readonly') {
      this.grantsByToken.delete(token);
      this.tokensByGrant.delete(grant);
      this.deniedTokens.delete(token);
      return false;
    }
    const allowed = VAULT_READONLY_TOOLS.has(`${agent}:${tool}`);
    if (!allowed) {
      this.deniedTokens.add(token);
    }
    return allowed;
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
