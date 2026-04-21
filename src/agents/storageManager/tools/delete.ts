import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DeleteParams, DeleteResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { normalizePath } from '../../../utils/pathUtils';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

/**
 * Location: src/agents/storageManager/tools/delete.ts
 * Purpose: Delete a file or folder from the vault.
 * Default is recoverable (system trash); permanent=true bypasses trash.
 *
 * Relationships: Uses Obsidian vault API directly (vault.trash / vault.delete).
 *
 * Rationale: fork-local tool (gcp007-ops/nexus) — replaces a runtime
 * monkey-patch that used to inject this in the ThinkBox plugin. Committed
 * in the fork so updates survive Nexus upstream refreshes without patching.
 */
export class DeleteTool extends BaseTool<DeleteParams, DeleteResult> {
  private app: App;

  constructor(app: App) {
    super(
      'delete',
      'Delete',
      'Delete a file or folder (moves to system trash by default — recoverable)',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Deleting', 'Deleted', 'Failed to delete'), params, tense);
  }

  async execute(params: DeleteParams): Promise<DeleteResult> {
    const { path, permanent } = params;

    try {
      const normalizedPath = normalizePath(path);
      const item = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!item) {
        return this.prepareResult(
          false,
          undefined,
          `File or folder not found: "${path}". Use list to see available items, or searchContent to find files by name.`
        );
      }

      // Default: fileManager.trashFile respects user's Obsidian preference
      // (system trash / .trash folder / permanent). permanent=true forces
      // vault.delete to bypass user preference and delete irreversibly.
      if (permanent) {
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- intentional: programmatic override of user trash preference
        await this.app.vault.delete(item, true);
      } else {
        await this.app.fileManager.trashFile(item);
      }

      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to delete: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file or folder to delete'
        },
        permanent: {
          type: 'boolean',
          description: 'If true, permanently delete (skip trash). Default false (recoverable via system trash).',
          default: false
        }
      },
      required: ['path'],
      description: 'Delete a file or folder. Default moves to system trash (recoverable via Finder/Explorer). Use permanent=true to bypass trash (irreversible).'
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}
