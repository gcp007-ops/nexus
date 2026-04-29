/**
 * tests/eval/types.ts — Type definitions for the LLM eval harness.
 *
 * Defines EvalConfig, EvalScenario, EvalTurn, and related types used by
 * ConfigLoader, ScenarioLoader, EvalRunner, and the Jest entry point.
 */

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  apiKeyEnv: string;
  models: string[];
  enabled: boolean;
}

export interface CaptureConfig {
  enabled: boolean;
  dumpOnFailure: boolean;
  artifactsDir: string;
}

export interface EvalDefaults {
  temperature: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  timeout: number;
  systemPrompt: string;
}

export interface EvalConfig {
  mode: 'mock' | 'live';
  testVaultPath?: string;
  providers: Record<string, ProviderConfig>;
  defaults: EvalDefaults;
  capture: CaptureConfig;
  scenarios: string;
  /**
   * Optional scenario tool-surface filter.
   * - 'all': run every scenario regardless of toolSet
   * - 'meta': production two-tool architecture only
   * - 'nexus' / 'simple': targeted legacy/direct tool surfaces
   */
  scenarioToolSet?: ToolSetType | 'all';
  /**
   * Optional scenario-name filter for focused debugging runs.
   */
  scenarioNames?: string[];
}

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

export interface ExpectedToolCall {
  name: string;
  params?: Record<string, unknown>;
  optional?: boolean;
}

export interface MockToolResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface EvalTurn {
  userMessage?: string;
  expectedTools: ExpectedToolCall[];
  mockResponses: Record<string, MockToolResponse>;
}

/**
 * Which tool set a scenario uses:
 * - 'meta' (default): getTools + useTools — mirrors production two-tool architecture
 * - 'nexus': domain tools exposed directly (for targeted domain-tool testing)
 * - 'simple': basic test tools (get_weather, get_time)
 */
export type ToolSetType = 'meta' | 'nexus' | 'simple';

export interface EvalScenario {
  name: string;
  description: string;
  /**
   * Files to seed into the headless live test vault before this scenario runs.
   * Mock mode ignores this because mockResponses provide tool outputs directly.
   */
  seedFiles?: Record<string, string>;
  providers?: string[];
  models?: string[];
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
  systemPrompt?: string;
  toolSet?: ToolSetType;
  /**
   * When true, tool call round ordering is not enforced.
   * All expected tools must appear across all rounds, but the round
   * assignment doesn't matter. Use for scenarios where the model may
   * execute search before read or vice versa.
   */
  allowReorder?: boolean;
  turns: EvalTurn[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CapturedToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  timestamp: number;
}

export interface TurnResult {
  turnIndex: number;
  passed: boolean;
  expectedTools: ExpectedToolCall[];
  actualToolCalls: CapturedToolCall[];
  textContent: string;
  errors: string[];
  durationMs: number;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  provider: string;
  model: string;
  passed: boolean;
  turns: TurnResult[];
  totalDurationMs: number;
  retryCount: number;
  error?: string;
  tracePath?: string;
}

export interface EvalRunResult {
  config: string;
  mode: 'mock' | 'live';
  results: ScenarioResult[];
  startTime: number;
  endTime: number;
}
