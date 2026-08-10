import { GetToolsTool } from '../../src/agents/toolManager/tools/getTools';
import { UseToolTool } from '../../src/agents/toolManager/tools/useTools';
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { getTopLevelToolContextSchema } from '../../src/agents/toolManager/types';
import type { IAgent } from '../../src/agents/interfaces/IAgent';

function requiredFields(schema: Record<string, unknown>): string[] {
  return schema.required as string[];
}

function workspaceDescription(schema: Record<string, unknown>): string {
  const properties = schema.properties as Record<string, { description?: string }>;
  return properties.workspaceId.description ?? '';
}

describe('ToolManager optional workspace schema', () => {
  const registry = new Map<string, IAgent>();

  it('does not require workspaceId in either meta-tool envelope', () => {
    const getTools = new GetToolsTool(registry, {
      workspaces: [],
      customAgents: [],
      vaultRoot: []
    });
    const useTools = new UseToolTool(
      { execute: jest.fn() } as never,
      new ToolCliNormalizer(registry)
    );

    expect(requiredFields(getTools.getParameterSchema())).not.toContain('workspaceId');
    expect(requiredFields(useTools.getParameterSchema())).not.toContain('workspaceId');
  });

  it('describes omission as session inheritance instead of unconditional defaulting', () => {
    const sharedSchema = {
      type: 'object',
      properties: getTopLevelToolContextSchema()
    };

    expect(workspaceDescription(sharedSchema)).toMatch(/session/i);
    expect(workspaceDescription(sharedSchema)).not.toMatch(/defaults to "default"/i);
  });
});
