import {
  calculateMaxRetryDelayMs,
  calculateRetryDelayMs,
  isRetryableEvalError,
} from '../eval/EvalRunner';
import type { EvalConfig } from '../eval/types';

const config: EvalConfig = {
  mode: 'live',
  providers: {},
  defaults: {
    temperature: 0,
    maxRetries: 4,
    retryDelayMs: 500,
    retryBackoffMultiplier: 2,
    retryMaxDelayMs: 2_000,
    timeout: 120_000,
    systemPrompt: 'default',
  },
  capture: {
    enabled: false,
    dumpOnFailure: false,
    artifactsDir: 'test-artifacts/',
  },
  scenarios: 'tests/eval/scenarios/**/*.eval.yaml',
};

describe('EvalRunner retry helpers', () => {
  it('identifies rate limits, server errors, and transient transport failures as retryable', () => {
    expect(isRetryableEvalError(new Error('OpenRouter returned HTTP 429 rate limit'))).toBe(true);
    expect(isRetryableEvalError(new Error('Provider stream failed with 503 Service unavailable'))).toBe(true);
    expect(isRetryableEvalError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableEvalError({ status: 500, message: 'Internal server error' })).toBe(true);
    expect(isRetryableEvalError({ response: { status: 504 }, message: 'Gateway timeout' })).toBe(true);
  });

  it('does not retry authentication and validation failures', () => {
    expect(isRetryableEvalError(new Error('HTTP 401 Unauthorized'))).toBe(false);
    expect(isRetryableEvalError(new Error('HTTP 400 invalid request'))).toBe(false);
    expect(isRetryableEvalError({ status: 403, message: 'Forbidden' })).toBe(false);
  });

  it('calculates capped exponential backoff delays', () => {
    expect(calculateRetryDelayMs(0, config)).toBe(500);
    expect(calculateRetryDelayMs(1, config)).toBe(1_000);
    expect(calculateRetryDelayMs(2, config)).toBe(2_000);
    expect(calculateRetryDelayMs(3, config)).toBe(2_000);
    expect(calculateMaxRetryDelayMs(4, config)).toBe(5_500);
  });
});
