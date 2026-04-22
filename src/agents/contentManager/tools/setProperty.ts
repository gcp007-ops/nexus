import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { SetPropertyParams, SetPropertyResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Location: src/agents/contentManager/tools/setProperty.ts
 *
 * Tool for setting frontmatter properties on notes.
 * Supports two modes:
 * - "replace" (default): overwrites the property value
 * - "merge": performs array union with dedup for list fields;
 *   equivalent to replace for scalars
 *
 * Uses Obsidian's fileManager.processFrontMatter() for atomic
 * frontmatter manipulation.
 *
 * Relationships:
 * - Part of ContentManager agent (CRUA + property operations)
 * - Follows write tool response stripping principle (returns { success: true } only)
 *
 * Ref: #33
 */
export class SetPropertyTool extends BaseTool<SetPropertyParams, SetPropertyResult> {
  private app: App;

  constructor(app: App) {
    super(
      'setProperty',
      'Set property',
      'Set a frontmatter property on a note. Supports "replace" (default) and "merge" (array union with dedup) modes.',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Setting property on', 'Set property on', 'Failed to set property on'), params, tense);
  }

  async execute(params: SetPropertyParams): Promise<SetPropertyResult> {
    try {
      const { path, property, value, mode = 'replace' } = params;

      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (!file) {
        return this.prepareResult(false, undefined,
          `File not found: "${path}". Use searchContent to find files by name, or storageManager.list to explore folders.`
        );
      }

      if (!(file instanceof TFile)) {
        return this.prepareResult(false, undefined,
          `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`
        );
      }

      let mergeError: string | null = null;

      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (mode === 'merge') {
          const existing = frontmatter[property];

          // Promote scalar string value to single-item array when existing
          // field is an array. Rationale: CLI single-item calls (e.g.,
          // `set-property tags "nova-tag" --mode merge`) were previously
          // rejected as type-mismatch (array vs scalar), forcing callers
          // into wasteful workarounds. A scalar string in merge intent over
          // an existing array is unambiguous: append the item.
          // Paired with ToolCliNormalizer oneOfArray coercion (multi-item
          // CSV → array) so both N=1 and N>=2 flows work without overwrite.
          const normalizedValue =
            Array.isArray(existing) && typeof value === 'string'
              ? [value]
              : value;

          if (existing === undefined || existing === null) {
            frontmatter[property] = normalizedValue;
          } else if (isStringArray(existing) && isStringArray(normalizedValue)) {
            const merged = [...existing];
            for (const item of normalizedValue) {
              if (!merged.includes(item)) {
                merged.push(item);
              }
            }
            frontmatter[property] = merged;
          } else if (Array.isArray(existing) !== Array.isArray(normalizedValue)) {
            mergeError =
              `Cannot merge: existing value is ${Array.isArray(existing) ? 'array' : 'scalar'} ` +
              `but new value is ${Array.isArray(normalizedValue) ? 'array' : 'scalar'}. ` +
              `Use mode "replace" to overwrite, or ensure both values are the same type.`;
            return;
          } else {
            // Scalar + Scalar: equivalent to replace
            frontmatter[property] = normalizedValue;
          }
        } else {
          frontmatter[property] = value;
        }
      });

      if (mergeError) {
        return this.prepareResult(false, undefined, mergeError);
      }

      return { success: true };
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error setting property: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note file'
        },
        property: {
          type: 'string',
          description: 'Frontmatter property name (e.g. "tags", "aliases", "status")'
        },
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Value to set. Can be a string, number, boolean, or array of strings.'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          default: 'replace',
          description: "How to apply the value. 'replace' overwrites (default). 'merge' performs array union with dedup for list fields; equivalent to replace for scalars."
        }
      },
      required: ['path', 'property', 'value']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
