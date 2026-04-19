import { ITool } from '../../interfaces/ITool';
import { ToolBatchExecutionService } from '../services/ToolBatchExecutionService';
import { ToolCliNormalizer } from '../services/ToolCliNormalizer';
import { NormalizedUseToolParams, UseToolParams, UseToolResult } from '../types';

export class UseToolTool implements ITool<UseToolParams, UseToolResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  constructor(
    private batchExecutionService: ToolBatchExecutionService,
    private cliNormalizer: ToolCliNormalizer
  ) {
    this.slug = 'useTools';
    this.name = 'Use Tools';
    this.description = 'Execute one or more CLI-style tool commands. IMPORTANT: You MUST call getTools first to inspect the exact command signatures before calling this tool.';
    this.version = '1.0.0';
  }

  async execute(params: UseToolParams): Promise<UseToolResult> {
    const normalizedParams: NormalizedUseToolParams = {
      context: this.cliNormalizer.normalizeContext(params),
      calls: this.cliNormalizer.normalizeExecutionCalls(params),
      strategy: params.strategy
    };
    return this.batchExecutionService.execute(normalizedParams);
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace ID. Optional. Defaults to "default".'
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for traces. Optional; auto-generated if omitted.'
        },
        memory: {
          type: 'string',
          description: 'Brief summary of the conversation so far.'
        },
        goal: {
          type: 'string',
          description: 'Brief statement of the current objective.'
        },
        constraints: {
          type: 'string',
          description: 'Optional rules or limits.'
        },
        tool: {
          type: 'string',
          description: 'CLI-style tool command string. Supports one or more commands separated by commas. Example: \'content read "notes/today.md"\'. For payloads containing literal quotes, newlines, commas, leading "--", or YAML frontmatter "---" markers (anything shell-fragile), use heredoc syntax — content between <<< and >>> is preserved verbatim with no escape required: \'content write "notes/post.md" <<<---\\ntitle: My Post\\n---\\n\\nBody with "literal quotes" and newlines.\\n>>>\'. If the payload itself contains >>> use named heredoc instead: \'content write "x.md" <<BODY ... BODY\' (BODY = uppercase 1-32 chars). Multiple commands separated by commas are safe even when a heredoc body contains commas — the raw block is opaque to the comma splitter.'
        }
      },
      required: ['memory', 'goal', 'tool']
    };
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'True if all commands succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if any commands failed'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string' },
                  tool: { type: 'string' },
                  params: { type: 'object' },
                  success: { type: 'boolean' },
                  error: { type: 'string' },
                  data: {}
                },
                required: ['agent', 'tool', 'success']
              }
            }
          }
        }
      }
    };
  }
}
