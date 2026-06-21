import { ModelSpec } from '../modelTypes';

export const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = 'Gemini 3.5 Flash (Medium)';

const AGY_GEMINI_MODEL_NAMES = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
];

const LEGACY_GEMINI_CLI_MODEL_IDS = new Set([
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro-preview',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

export const GOOGLE_GEMINI_CLI_MODELS: ModelSpec[] = AGY_GEMINI_MODEL_NAMES.map((name) => ({
  provider: 'google-gemini-cli',
  name,
  apiName: name,
  contextWindow: 1048576,
  maxTokens: 65536,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  capabilities: {
    supportsJSON: true,
    supportsImages: true,
    supportsFunctions: true,
    supportsStreaming: false,
    supportsThinking: true,
  },
}));

export function normalizeGeminiCliModelForAgy(modelId?: string): string {
  if (!modelId || LEGACY_GEMINI_CLI_MODEL_IDS.has(modelId)) {
    return GOOGLE_GEMINI_CLI_DEFAULT_MODEL;
  }

  if (AGY_GEMINI_MODEL_NAMES.includes(modelId)) {
    return modelId;
  }

  return GOOGLE_GEMINI_CLI_DEFAULT_MODEL;
}
