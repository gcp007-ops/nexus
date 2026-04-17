/**
 * tests/eval/ScenarioLoader.ts — Loads YAML scenario files from a directory.
 *
 * Reads scenario YAML files from disk and parses them into EvalScenario[].
 * Each YAML file contains an array of scenario objects. Used by eval.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { EvalScenario } from './types';

type ScenarioEntry = Record<string, unknown>;
type ToolMap = Map<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

function splitTopLevelSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if ((char === '"' || char === '\'') && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      current += char;
      continue;
    }

    if (char === ',' && !quote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }

  return segments;
}

function getSchemaType(schema: Record<string, unknown>): string {
  if (schema.type === 'array') {
    const items = isRecord(schema.items) ? schema.items : {};
    return `array<${typeof items.type === 'string' ? items.type : 'unknown'}>`;
  }
  return typeof schema.type === 'string' ? schema.type : 'unknown';
}

function buildCliArguments(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );

  return Object.entries(properties).map(([name, rawSchema]) => {
    const property = isRecord(rawSchema) ? rawSchema : {};
    const type = getSchemaType(property);
    const requiredArg = required.has(name);
    const positional = requiredArg && type !== 'boolean' && type !== 'object' && !type.startsWith('array<');
    return {
      name,
      flag: `--${toKebabCase(name)}`,
      type,
      required: requiredArg,
      positional,
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
    };
  });
}

function buildUsage(command: string, args: Array<Record<string, unknown>>): string {
  const parts = [command];
  for (const arg of args) {
    const name = String(arg.name);
    const flag = String(arg.flag);
    const type = String(arg.type);
    const required = Boolean(arg.required);
    const positional = Boolean(arg.positional);

    if (positional) {
      parts.push(`<${name}>`);
    } else if (type === 'boolean') {
      parts.push(required ? flag : `[${flag}]`);
    } else {
      parts.push(required ? `${flag} <${name}>` : `[${flag} <${name}>]`);
    }
  }
  return parts.join(' ');
}

function buildExample(command: string, args: Array<Record<string, unknown>>): string {
  const parts = [command];
  for (const arg of args) {
    const name = String(arg.name);
    const flag = String(arg.flag);
    const type = String(arg.type);
    const positional = Boolean(arg.positional);
    const required = Boolean(arg.required);

    if (type === 'boolean') {
      if (required) {
        parts.push(flag);
      }
      continue;
    }

    const value = type === 'number' || type === 'integer'
      ? '1'
      : type.startsWith('array<')
        ? '"value-1,value-2"'
        : type === 'object'
          ? '\'{"key":"value"}\''
          : `"${name}-value"`;

    if (positional) {
      parts.push(value);
    } else {
      parts.push(flag, value);
    }
  }
  return parts.join(' ');
}

function normalizeGetToolsSelectors(params: Record<string, unknown>): string | null {
  if (typeof params.tool === 'string' && params.tool.trim().length > 0) {
    return params.tool.trim();
  }

  if (Array.isArray(params.agents)) {
    return params.agents
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(toKebabCase)
      .join(', ');
  }

  if (Array.isArray(params.request)) {
    return params.request
      .filter(isRecord)
      .map((item) => {
        const agent = typeof item.agent === 'string' ? toKebabCase(item.agent) : '';
        const tools = Array.isArray(item.tools)
          ? item.tools.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(toKebabCase)
          : [];
        if (!agent) return '';
        return tools.length > 0 ? `${agent} ${tools[0]}` : agent;
      })
      .filter(Boolean)
      .join(', ');
  }

  return null;
}

function inferAgentAlias(toolName: string, knownTools: ToolMap): string | null {
  const normalized = toolName.includes('_') ? toolName.split('_')[0] : toolName;
  const explicit = knownTools.get(normalized) || knownTools.get(toolName);
  if (explicit) return explicit;

  const fallback: Record<string, string> = {
    read: 'content',
    write: 'content',
    replace: 'content',
    insert: 'content',
    'set-property': 'content',
    setProperty: 'content',
    move: 'storage',
    copy: 'storage',
    archive: 'storage',
    list: 'storage',
    createFolder: 'storage',
    'create-folder': 'storage',
    open: 'storage',
    searchContent: 'search',
    'search-content': 'search',
    searchDirectory: 'search',
    'search-directory': 'search',
    searchMemory: 'search',
    'search-memory': 'search',
  };

  return fallback[toolName] || fallback[normalized] || null;
}

function inferUseToolsCommand(
  mockResponses: Record<string, unknown> | undefined,
  knownTools: ToolMap,
): string | null {
  const useToolsResponse = isRecord(mockResponses?.useTools) ? mockResponses.useTools : null;
  const result = useToolsResponse && isRecord(useToolsResponse.result) ? useToolsResponse.result : null;
  const results = result && Array.isArray(result.results) ? result.results : [];
  const commands = results
    .filter(isRecord)
    .map((item) => typeof item.tool === 'string' ? item.tool : '')
    .filter(Boolean)
    .map((toolName) => {
      const agent = inferAgentAlias(toolName, knownTools);
      const slug = toolName.includes('_') ? toolName.split('_')[1] : toolName;
      return agent ? `${agent} ${toKebabCase(slug)}` : '';
    })
    .filter(Boolean);

  return commands.length > 0 ? commands.join(', ') : null;
}

function normalizeGetToolsResponse(entry: Record<string, unknown>, knownTools: ToolMap): void {
  const getToolsResponse = isRecord(entry.mockResponses) && isRecord(entry.mockResponses.getTools)
    ? entry.mockResponses.getTools
    : null;
  const result = getToolsResponse && isRecord(getToolsResponse.result) ? getToolsResponse.result : null;
  const tools = result && Array.isArray(result.tools) ? result.tools : null;

  if (!tools) return;

  result.tools = tools.map((item) => {
    if (!isRecord(item)) return item;
    if (typeof item.command === 'string' && typeof item.usage === 'string') {
      return item;
    }

    const rawAgent = typeof item.agent === 'string'
      ? item.agent
      : typeof item.name === 'string' && item.name.includes('_')
        ? item.name.split('_')[0]
        : '';
    const rawTool = typeof item.tool === 'string'
      ? item.tool
      : typeof item.name === 'string' && item.name.includes('_')
        ? item.name.split('_')[1]
        : '';
    const agentAlias = rawAgent ? toKebabCase(rawAgent) : inferAgentAlias(rawTool, knownTools);
    if (!agentAlias || !rawTool) return item;

    knownTools.set(rawTool, agentAlias);
    knownTools.set(toKebabCase(rawTool), agentAlias);

    const command = `${agentAlias} ${toKebabCase(rawTool)}`;
    const schema = isRecord(item.inputSchema)
      ? item.inputSchema
      : isRecord(item.parameters)
        ? item.parameters
        : { type: 'object', properties: {} };
    const args = buildCliArguments(schema);

    return {
      agent: rawAgent || `${agentAlias}Manager`,
      tool: rawTool,
      description: typeof item.description === 'string' ? item.description : '',
      command,
      usage: buildUsage(command, args),
      arguments: args,
      examples: [buildExample(command, args)],
    };
  });
}

function normalizeScenario(rawScenario: EvalScenario): EvalScenario {
  const scenario = structuredClone(rawScenario) as ScenarioEntry;
  const knownTools: ToolMap = new Map();

  if (Array.isArray(scenario.turns)) {
    for (const turn of scenario.turns) {
      if (!isRecord(turn)) continue;

      if (Array.isArray(turn.expectedTools)) {
        for (const expected of turn.expectedTools) {
          if (!isRecord(expected)) continue;
          if (expected.name === 'getTools' && isRecord(expected.params)) {
            const selector = normalizeGetToolsSelectors(expected.params);
            if (selector) {
              expected.params = { tool: selector };
            }
          }
        }
      }

      normalizeGetToolsResponse(turn, knownTools);

      if (Array.isArray(turn.expectedTools)) {
        for (const expected of turn.expectedTools) {
          if (!isRecord(expected) || expected.name !== 'useTools') continue;
          const params = isRecord(expected.params) ? expected.params : {};
          if (typeof params.tool === 'string' && params.tool.trim().length > 0) {
            expected.params = params;
            continue;
          }

          const inferred = inferUseToolsCommand(
            isRecord(turn.mockResponses) ? turn.mockResponses : undefined,
            knownTools,
          );
          if (inferred) {
            expected.params = { ...params, tool: inferred };
          }
        }
      }
    }
  }

  return scenario as EvalScenario;
}

/**
 * Load all scenarios matching the glob-like pattern.
 * Supports simple patterns like "tests/eval/scenarios/**\/*.eval.yaml".
 */
export async function loadScenarios(
  pattern: string,
  basePath?: string
): Promise<EvalScenario[]> {
  const cwd = basePath || process.cwd();

  // Extract the base directory and file suffix from the pattern
  // e.g., "tests/eval/scenarios/**/*.eval.yaml" -> dir="tests/eval/scenarios", suffix=".eval.yaml"
  const parts = pattern.split('**/');
  const baseDir = path.resolve(cwd, parts[0].replace(/\/$/, ''));
  const fileSuffix = parts.length > 1 ? parts[1].replace(/^\*/, '') : '.eval.yaml';

  if (!fs.existsSync(baseDir)) {
    console.warn(`[ScenarioLoader] Directory not found: ${baseDir}`);
    return [];
  }

  const files = findFilesRecursive(baseDir, fileSuffix);

  if (files.length === 0) {
    console.warn(`[ScenarioLoader] No scenario files found in: ${baseDir}`);
    return [];
  }

  const scenarios: EvalScenario[] = [];

  for (const file of files.sort()) {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = parseYaml(raw);
    const fileName = path.basename(file);

    if (!Array.isArray(parsed)) {
      console.warn(`[ScenarioLoader] ${fileName}: expected array, got ${typeof parsed} — skipping`);
      continue;
    }

    for (const entry of parsed) {
      if (!entry.name || !entry.turns) {
        console.warn(`[ScenarioLoader] ${fileName}: scenario missing name or turns — skipping`);
        continue;
      }
      scenarios.push(normalizeScenario(entry as EvalScenario));
    }
  }

  return scenarios;
}

/**
 * Recursively find files ending with a given suffix.
 */
function findFilesRecursive(dir: string, suffix: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }

  return results;
}
