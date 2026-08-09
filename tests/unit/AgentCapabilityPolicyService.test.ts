import { AgentCapabilityPolicyService } from '../../src/services/workflows/AgentCapabilityPolicyService';

describe('AgentCapabilityPolicyService', () => {
  it('uses distinct secure tokens by default', () => {
    const policy = new AgentCapabilityPolicyService();

    const first = policy.issue('run-1', 'vault-readonly');
    const second = policy.issue('run-2', 'vault-readonly');

    expect(first.token).not.toBe(second.token);
  });

  it('issues an in-memory vault-readonly grant with a literal read allowlist', () => {
    const policy = new AgentCapabilityPolicyService(() => 'token-1');

    const issued = policy.issue('run-1', 'vault-readonly');

    expect(issued.token).toBe('token-1');
    expect(policy.resolve(issued.token)).toMatchObject({
      runId: 'run-1',
      profile: 'vault-readonly'
    });
    expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(true);
    expect(policy.allows(issued.grant, 'searchManager', 'content')).toBe(true);
    expect(policy.allows(issued.grant, 'memoryManager', 'loadWorkspace')).toBe(true);
    for (const [agent, tool] of [
      ['storageManager', 'list'],
      ['searchManager', 'directory'],
      ['searchManager', 'memory'],
      ['memoryManager', 'listStates'],
      ['memoryManager', 'loadState'],
      ['memoryManager', 'listWorkspaces'],
      ['taskManager', 'listProjects'],
      ['taskManager', 'list'],
      ['taskManager', 'query'],
      ['taskManager', 'open'],
      ['canvasManager', 'read'],
      ['canvasManager', 'list']
    ]) {
      expect(policy.allows(issued.grant, agent, tool)).toBe(true);
    }
    expect(policy.allows(issued.grant, 'contentManager', 'write')).toBe(false);
    expect(policy.allows(issued.grant, 'storageManager', 'move')).toBe(false);
    expect(policy.allows(issued.grant, 'taskManager', 'update')).toBe(false);
    expect(policy.allows(issued.grant, 'memoryManager', 'run')).toBe(false);
    expect(policy.allows(issued.grant, 'promptManager', 'get')).toBe(false);
  });

  it('expires and revokes bearer tokens without returning the token in the grant', () => {
    let now = 1_000;
    const policy = new AgentCapabilityPolicyService(() => 'token-1', () => now);
    const issued = policy.issue('run-1', 'vault-readonly', 50);

    expect(issued.grant).not.toHaveProperty('token');
    expect(policy.resolve('token-1')).toEqual(issued.grant);

    now = 1_050;
    expect(policy.resolve('token-1')).toBeUndefined();

    const second = new AgentCapabilityPolicyService(() => 'token-2');
    second.issue('run-2', 'vault-readonly');
    second.revoke('token-2');
    expect(second.resolve('token-2')).toBeUndefined();
  });

  it('accepts only the exact actively issued grant and rejects forged or revoked grants', () => {
    const policy = new AgentCapabilityPolicyService(() => 'token-1');
    const issued = policy.issue('run-1', 'vault-readonly');
    const forgedGrant = {
      runId: issued.grant.runId,
      profile: issued.grant.profile,
      expiresAt: issued.grant.expiresAt
    };

    expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(true);
    expect(policy.allows(forgedGrant, 'contentManager', 'read')).toBe(false);

    policy.revoke(issued.token);
    expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(false);
  });

  it('invalidates an issued grant when its active issuance expires', () => {
    let now = 1_000;
    const policy = new AgentCapabilityPolicyService(() => 'token-1', () => now);
    const issued = policy.issue('run-1', 'vault-readonly', 50);

    expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(true);

    now = 1_050;
    expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(false);
  });

  it('returns a structured denial bit when revoking a denied valid grant', () => {
    const policy = new AgentCapabilityPolicyService(() => 'token-1');
    const issued = policy.issue('run-1', 'vault-readonly');

    expect(policy.allows(issued.grant, 'contentManager', 'write')).toBe(false);
    expect(policy.revoke(issued.token)).toBe(true);
    expect(policy.revoke(issued.token)).toBe(false);
  });
});
