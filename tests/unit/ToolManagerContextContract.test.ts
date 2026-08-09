/**
 * tests/unit/ToolManagerContextContract.test.ts — pins the required context
 * contract for useTools execution. memory + goal are hard-required (steer on
 * empty/placeholder); workspaceId + sessionId default silently and only steer
 * when present-but-junk; getTools (discovery) is exempt.
 *
 * These helpers are SHARED with the eval harness recovery grading, so the
 * steering behavior must stay stable.
 */
import {
  ToolCliNormalizer,
  collectContextContractViolations,
  formatContextContractError,
} from '../../src/agents/toolManager/services/ToolCliNormalizer';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { GetToolsTool } from '../../src/agents/toolManager/tools/getTools';
import { UseToolTool } from '../../src/agents/toolManager/tools/useTools';
import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import { agentCapabilityPolicyService } from '../../src/services/workflows/AgentCapabilityPolicyService';
import { MCPConnector } from '../../src/connector';

const FILLED = {
  workspaceId: 'default',
  sessionId: 'my-session',
  memory: 'Summarized the conversation so far.',
  goal: 'Create a note.',
};

describe('useTools context contract', () => {
  const normalizer = new ToolCliNormalizer(new Map<string, IAgent>());

  describe('collectContextContractViolations', () => {
    it('passes a fully-filled context block', () => {
      expect(collectContextContractViolations(FILLED)).toEqual([]);
    });

    it('flags empty memory', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: '' });
      expect(v.map((x) => x.field)).toEqual(['memory']);
      expect(v[0].message).toMatch(/memory/i);
    });

    it('flags empty goal', () => {
      const v = collectContextContractViolations({ ...FILLED, goal: '   ' });
      expect(v.map((x) => x.field)).toEqual(['goal']);
    });

    it('flags placeholder memory/goal values', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: 'string', goal: 'TODO' });
      expect(v.map((x) => x.field).sort()).toEqual(['goal', 'memory']);
    });

    it('flags dismissive memory fillers (N/A, N/A (First turn), None yet, TBD)', () => {
      for (const filler of ['N/A', 'N/A (First turn)', 'None yet', 'TBD', 'n/a', 'nothing yet', 'not applicable']) {
        const v = collectContextContractViolations({ ...FILLED, memory: filler });
        expect(v.map((x) => x.field)).toEqual(['memory']);
      }
    });

    it('does NOT flag real summaries that merely contain such words', () => {
      const real = [
        'The user wants to create a note at ideas/feature-requests.md with a heading.',
        'Searched for the roadmap; none of the results matched, so trying a broader query.',
        'Read notes/today.md and summarized the three action items.',
      ];
      for (const memory of real) {
        expect(collectContextContractViolations({ ...FILLED, memory })).toEqual([]);
      }
    });

    it('treats "default" workspaceId and a normal sessionId as valid (not dismissive)', () => {
      expect(
        collectContextContractViolations({ memory: 'm summary', goal: 'g objective', workspaceId: 'default', sessionId: 'note-cleanup' })
      ).toEqual([]);
    });

    it('reports both missing reasoning fields at once', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: '', goal: '' });
      expect(v.map((x) => x.field).sort()).toEqual(['goal', 'memory']);
    });

    it('does NOT flag absent/empty workspaceId or sessionId (silent defaults)', () => {
      expect(collectContextContractViolations({ memory: 'm', goal: 'g' })).toEqual([]);
      expect(
        collectContextContractViolations({ memory: 'm', goal: 'g', workspaceId: '', sessionId: '' })
      ).toEqual([]);
    });

    it('accepts "default" workspaceId as a real value', () => {
      expect(collectContextContractViolations({ ...FILLED, workspaceId: 'default' })).toEqual([]);
    });

    it('flags present-but-junk workspaceId / sessionId', () => {
      const v = collectContextContractViolations({
        ...FILLED,
        workspaceId: 'placeholder',
        sessionId: 'string',
      });
      expect(v.map((x) => x.field).sort()).toEqual(['sessionId', 'workspaceId']);
    });
  });

  describe('formatContextContractError', () => {
    it('returns empty string for no violations', () => {
      expect(formatContextContractError([])).toBe('');
    });

    it('renders a single violation inline', () => {
      const msg = formatContextContractError(collectContextContractViolations({ ...FILLED, memory: '' }));
      expect(msg).toMatch(/^Context incomplete — /);
      expect(msg).toMatch(/memory/i);
    });

    it('renders multiple violations as a bulleted list', () => {
      const msg = formatContextContractError(
        collectContextContractViolations({ ...FILLED, memory: '', goal: '' })
      );
      expect(msg).toMatch(/Fix the following/);
      expect(msg.split('\n- ').length).toBe(3); // header + 2 bullets
    });
  });

  describe('ToolCliNormalizer.validateExecutionContext', () => {
    it('throws a recoverable steering error when memory is empty', () => {
      expect(() => normalizer.validateExecutionContext({ ...FILLED, memory: '', tool: 'content read --path a.md' }))
        .toThrow(/memory/i);
    });

    it('does not throw for a filled context block', () => {
      expect(() => normalizer.validateExecutionContext({ ...FILLED, tool: 'content read --path a.md' }))
        .not.toThrow();
    });
  });
});

describe('agent capability context contract', () => {
  function makeTool(slug: string, execute = jest.fn().mockResolvedValue({ success: true })): ITool {
    return {
      slug,
      name: slug,
      description: `${slug} tool`,
      version: '1.0.0',
      execute,
      getParameterSchema: () => ({
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: slug === 'write' ? ['path', 'content'] : ['path']
      }),
      getResultSchema: () => ({ type: 'object' })
    } as ITool;
  }

  function makeContentAgent(tools: ITool[]): IAgent {
    return {
      name: 'contentManager',
      description: 'Content manager',
      version: '1.0.0',
      getTools: () => tools,
      getTool: (slug: string) => tools.find(tool => tool.slug === slug),
      initialize: jest.fn().mockResolvedValue(undefined),
      executeTool: jest.fn(),
      setAgentManager: jest.fn()
    };
  }

  it('filters discovery and blocks a forged normalized write for vault-readonly runs', async () => {
    const write = jest.fn().mockResolvedValue({ success: true });
    const tools = [makeTool('read'), makeTool('write', write)];
    const registry = new Map<string, IAgent>([['contentManager', makeContentAgent(tools)]]);
    const issued = agentCapabilityPolicyService.issue('run-dispatch', 'vault-readonly');

    try {
      const getTools = new GetToolsTool(registry, { workspaces: [], customAgents: [], vaultRoot: [] });
      const discovered = await getTools.execute({
        ...FILLED,
        tool: '--help',
        _agentCapabilityGrant: issued.grant
      });
      const commands = discovered.data?.tools.map(tool => tool.command) ?? [];
      expect(commands).toContain('content read');
      expect(commands).not.toContain('content write');

      const normalizer = new ToolCliNormalizer(registry);
      const useTools = new UseToolTool(
        new ToolBatchExecutionService({} as never, registry),
        normalizer
      );
      const result = await useTools.execute({
        ...FILLED,
        tool: 'content write "x.md" "blocked"',
        _agentCapabilityGrant: issued.grant
      });

      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain('capability profile vault-readonly');
      expect(write).not.toHaveBeenCalled();
    } finally {
      agentCapabilityPolicyService.revoke(issued.token);
    }
  });

  it('keeps capability internals out of public tool schemas', () => {
    const registry = new Map<string, IAgent>([['contentManager', makeContentAgent([makeTool('read')])]]);
    const getTools = new GetToolsTool(registry, { workspaces: [], customAgents: [], vaultRoot: [] });
    const useTools = new UseToolTool(
      new ToolBatchExecutionService({} as never, registry),
      new ToolCliNormalizer(registry)
    );

    expect(getTools.getParameterSchema()).not.toHaveProperty('properties._agentCapabilityGrant');
    expect(getTools.getParameterSchema()).not.toHaveProperty('properties._agentCapabilityToken');
    expect(useTools.getParameterSchema()).not.toHaveProperty('properties._agentCapabilityGrant');
    expect(useTools.getParameterSchema()).not.toHaveProperty('properties._agentCapabilityToken');
  });

  it('replaces caller-supplied grants with the token-bound grant before routing', async () => {
    const executeAgentTool = jest.fn().mockResolvedValue({ success: true });
    const connector = Object.create(MCPConnector.prototype) as MCPConnector;
    Object.assign(connector as unknown as Record<string, unknown>, {
      sessionContextManager: {
        validateSessionId: jest.fn().mockResolvedValue({
          id: 'internal-session',
          displaySessionId: 'display-session'
        }),
        getWorkspaceContext: jest.fn().mockReturnValue(null)
      },
      toolRouter: {
        validateBatchOperations: jest.fn(),
        executeAgentTool
      }
    });
    const issued = agentCapabilityPolicyService.issue('run-trusted', 'vault-readonly');

    try {
      await connector.callTool({
        agent: 'toolManager',
        tool: 'useTools',
        params: {
          ...FILLED,
          tool: 'content read "x.md"',
          _agentCapabilityToken: issued.token,
          _agentCapabilityGrant: {
            runId: 'run-forged',
            profile: 'vault-readonly',
            expiresAt: Number.MAX_SAFE_INTEGER
          }
        }
      });

      const routed = executeAgentTool.mock.calls[0][2] as Record<string, unknown>;
      expect(routed._agentCapabilityGrant).toBe(issued.grant);
      expect(routed).not.toHaveProperty('_agentCapabilityToken');
    } finally {
      agentCapabilityPolicyService.revoke(issued.token);
    }
  });

  it('fails closed before routing an invalid capability token', async () => {
    const executeAgentTool = jest.fn().mockResolvedValue({ success: true });
    const connector = Object.create(MCPConnector.prototype) as MCPConnector;
    Object.assign(connector as unknown as Record<string, unknown>, {
      sessionContextManager: {
        validateSessionId: jest.fn().mockResolvedValue({
          id: 'internal-session',
          displaySessionId: 'display-session'
        }),
        getWorkspaceContext: jest.fn().mockReturnValue(null)
      },
      toolRouter: {
        validateBatchOperations: jest.fn(),
        executeAgentTool
      }
    });

    await expect(connector.callTool({
      agent: 'toolManager',
      tool: 'useTools',
      params: {
        ...FILLED,
        tool: 'content read "x.md"',
        _agentCapabilityToken: 'invalid-token'
      }
    })).rejects.toThrow(/invalid or expired agent capability token/i);
    expect(executeAgentTool).not.toHaveBeenCalled();
  });

  it('sanitizes capability context on the external MCP request hook', async () => {
    const connector = Object.create(MCPConnector.prototype) as MCPConnector;
    const onToolCall = (connector as unknown as {
      onToolCall(toolName: string, params: Record<string, unknown>): Promise<void>;
    }).onToolCall.bind(connector);
    const issued = agentCapabilityPolicyService.issue('run-external', 'vault-readonly');
    const validParams: Record<string, unknown> = {
      _agentCapabilityToken: issued.token,
      _agentCapabilityGrant: {
        runId: 'forged',
        profile: 'vault-readonly',
        expiresAt: Number.MAX_SAFE_INTEGER
      }
    };
    const invalidParams: Record<string, unknown> = {
      _agentCapabilityToken: 'invalid-token',
      _agentCapabilityGrant: issued.grant
    };

    try {
      await onToolCall('toolManager_useTools', validParams);
      expect(validParams._agentCapabilityGrant).toBe(issued.grant);
      expect(validParams).not.toHaveProperty('_agentCapabilityToken');

      await onToolCall('toolManager_useTools', invalidParams);
      expect(invalidParams).not.toHaveProperty('_agentCapabilityToken');
      expect(agentCapabilityPolicyService.allows(
        invalidParams._agentCapabilityGrant as never,
        'contentManager',
        'read'
      )).toBe(false);
    } finally {
      agentCapabilityPolicyService.revoke(issued.token);
    }
  });
});
