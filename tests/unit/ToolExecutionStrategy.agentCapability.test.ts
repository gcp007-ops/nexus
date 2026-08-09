import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import type {
  IRequestHandlerDependencies,
  ToolExecutionResult
} from '../../src/handlers/interfaces/IRequestHandlerServices';
import { ToolExecutionStrategy } from '../../src/handlers/strategies/ToolExecutionStrategy';
import { MCPConnector } from '../../src/connector';
import {
  agentCapabilityPolicyService
} from '../../src/services/workflows/AgentCapabilityPolicyService';

function makeTool(slug: string): ITool {
  return {
    slug,
    name: slug,
    description: '',
    version: '1.0.0',
    execute: jest.fn(),
    getParameterSchema: jest.fn().mockReturnValue({}),
    getResultSchema: jest.fn().mockReturnValue({})
  } as unknown as ITool;
}

function makeAgent(name: string, tools: ITool[]): IAgent {
  return {
    name,
    description: '',
    version: '1.0.0',
    getTools: () => tools,
    getTool: (slug: string) => tools.find(tool => tool.slug === slug),
    initialize: jest.fn(),
    executeTool: jest.fn(),
    setAgentManager: jest.fn()
  };
}

function makeDependencies(): IRequestHandlerDependencies {
  return {
    validationService: {
      validateToolParams: jest.fn(async (params: Record<string, unknown>) => params),
      validateSessionId: jest.fn(),
      validateBatchOperations: jest.fn(),
      validateBatchPaths: jest.fn()
    },
    sessionService: {
      processSessionId: jest.fn(async (sessionId?: string) => ({
        sessionId: sessionId ?? 'session-1',
        isNewSession: false,
        isNonStandardId: false
      })),
      generateSessionId: jest.fn(),
      isStandardSessionId: jest.fn(),
      shouldInjectInstructions: jest.fn().mockReturnValue(false)
    },
    toolExecutionService: {
      executeAgent: jest.fn(async () => ({ success: true, data: { ok: true } }))
    },
    responseFormatter: {
      formatToolExecutionResponse: jest.fn((result: ToolExecutionResult) => ({
        content: [{ type: 'text', text: JSON.stringify(result) }]
      })),
      formatSessionInstructions: jest.fn((_id, response) => response),
      formatErrorResponse: jest.fn(error => ({
        content: [{ type: 'text', text: error.message }]
      }))
    },
    toolListService: {} as never,
    resourceListService: {} as never,
    resourceReadService: {} as never,
    promptsListService: {} as never,
    toolHelpService: {} as never,
    schemaEnhancementService: {} as never
  };
}

function rawLegacyRequest(
  tool: string,
  extra: Record<string, unknown> = {}
): { params: { name: string; arguments: Record<string, unknown> } } {
  return {
    params: {
      name: 'contentManager_legacy',
      arguments: { tool, sessionId: 'session-1', ...extra }
    }
  };
}

describe('ToolExecutionStrategy agent capability boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('blocks a raw legacy mutator carrying a valid read-only grant', async () => {
    const issued = agentCapabilityPolicyService.issue('legacy-write', 'vault-readonly');
    const deps = makeDependencies();
    const agent = makeAgent('contentManager', [makeTool('write')]);
    const strategy = new ToolExecutionStrategy(deps, () => agent);

    const response = await strategy.handle(rawLegacyRequest('write', {
      _agentCapabilityGrant: issued.grant
    }));

    expect(deps.toolExecutionService.executeAgent).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('not allowed by capability profile vault-readonly');
    agentCapabilityPolicyService.revoke(issued.token);
  });

  it('blocks raw legacy reads carrying invalid or expired connector tokens without unrestricted fallback', async () => {
    const deps = makeDependencies();
    const agent = makeAgent('contentManager', [makeTool('read')]);
    const strategy = new ToolExecutionStrategy(deps, () => agent);
    const connector = Object.create(MCPConnector.prototype) as MCPConnector;
    const onToolCall = (connector as unknown as {
      onToolCall(toolName: string, params: Record<string, unknown>): Promise<void>;
    }).onToolCall.bind(connector);
    const invalidParams: Record<string, unknown> = {
      _agentCapabilityToken: 'invalid-agent-token'
    };

    await onToolCall('contentManager_legacy', invalidParams);
    const invalidResponse = await strategy.handle(rawLegacyRequest('read', invalidParams));

    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const issued = agentCapabilityPolicyService.issue('expired-read', 'vault-readonly', 1);
    now.mockReturnValue(1_002);
    const expiredParams: Record<string, unknown> = {
      _agentCapabilityToken: issued.token
    };
    await onToolCall('contentManager_legacy', expiredParams);
    const expiredResponse = await strategy.handle(rawLegacyRequest('read', expiredParams));

    expect(deps.toolExecutionService.executeAgent).not.toHaveBeenCalled();
    expect(invalidResponse.content[0].text).toContain('not allowed');
    expect(expiredResponse.content[0].text).toContain('not allowed');
    agentCapabilityPolicyService.revoke(issued.token);
  });

  it('strips trusted grant and token fields before validation, execution, trace and error readback', async () => {
    const issued = agentCapabilityPolicyService.issue('legacy-read', 'vault-readonly');
    const deps = makeDependencies();
    const agent = makeAgent('contentManager', [makeTool('read'), makeTool('write')]);
    const trace = jest.fn().mockResolvedValue(undefined);
    const strategy = new ToolExecutionStrategy(deps, () => agent, undefined, trace);

    await strategy.handle(rawLegacyRequest('read', {
      path: 'safe.md',
      _agentCapabilityGrant: issued.grant,
      _agentCapabilityToken: 'secret-agent-token',
      nested: { _agentCapabilityToken: 'nested-secret-agent-token' }
    }));
    const errorResponse = await strategy.handle(rawLegacyRequest('write', {
      path: 'blocked.md',
      _agentCapabilityGrant: issued.grant,
      _agentCapabilityToken: 'secret-agent-token',
      nested: { _agentCapabilityGrant: issued.grant }
    }));

    const validatedParams = (deps.validationService.validateToolParams as jest.Mock).mock.calls[0][0];
    const executedParams = (deps.toolExecutionService.executeAgent as jest.Mock).mock.calls[0][2];
    const tracedParams = trace.mock.calls.flatMap(call => [call[1]]);
    expect(validatedParams).not.toHaveProperty('_agentCapabilityGrant');
    expect(validatedParams).not.toHaveProperty('_agentCapabilityToken');
    expect(executedParams).not.toHaveProperty('_agentCapabilityGrant');
    expect(executedParams).not.toHaveProperty('_agentCapabilityToken');
    expect(JSON.stringify(tracedParams)).not.toContain('_agentCapability');
    expect(errorResponse.content[0].text).not.toContain('_agentCapability');
    expect(errorResponse.content[0].text).not.toContain('secret-agent-token');
    expect(errorResponse.content[0].text).not.toContain('legacy-read');
    agentCapabilityPolicyService.revoke(issued.token);
  });

  it('preserves the unrestricted legacy connector path when no capability context exists', async () => {
    const deps = makeDependencies();
    const agent = makeAgent('contentManager', [makeTool('write')]);
    const strategy = new ToolExecutionStrategy(deps, () => agent);

    await strategy.handle(rawLegacyRequest('write', { path: 'normal-connector.md' }));

    expect(deps.toolExecutionService.executeAgent).toHaveBeenCalledTimes(1);
  });

  it('removes capability fields from canonical ToolManager parameters before forwarding', async () => {
    const issued = agentCapabilityPolicyService.issue('canonical-read', 'vault-readonly');
    const deps = makeDependencies();
    const agent = makeAgent('toolManager', [makeTool('useTools')]);
    const strategy = new ToolExecutionStrategy(deps, () => agent);

    await strategy.handle({
      params: {
        name: 'toolManager_useTools',
        arguments: {
          sessionId: 'session-1',
          _agentCapabilityGrant: issued.grant,
          nested: { _agentCapabilityToken: 'nested-secret-agent-token' }
        }
      }
    });

    const validatedParams = (deps.validationService.validateToolParams as jest.Mock).mock.calls[0][0];
    const executedParams = (deps.toolExecutionService.executeAgent as jest.Mock).mock.calls[0][2];
    expect(JSON.stringify(validatedParams)).not.toContain('_agentCapability');
    expect(JSON.stringify(executedParams)).not.toContain('_agentCapability');
    expect(JSON.stringify(executedParams)).not.toContain('canonical-read');
    agentCapabilityPolicyService.revoke(issued.token);
  });
});
