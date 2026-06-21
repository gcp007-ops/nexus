# Task 2 Report — Replace Gemini CLI models with AGY labels

## Scope
- Updated `GOOGLE_GEMINI_CLI_MODELS` and `GOOGLE_GEMINI_CLI_DEFAULT_MODEL` to AGY Gemini labels.
- Added `normalizeGeminiCliModelForAgy`.
- Updated adapter unit tests in `GoogleGeminiCliAdapter.test.ts` to assert AGY model IDs and normalization behavior.

## TDD evidence
1. **Step 1 (tests-first)**
   - Updated first invocation test expected CLI model from `gemini-3-flash-preview` to `Gemini 3.5 Flash (Medium)`.
   - Replaced model list test expectations to the five AGY labels.
   - Added import of `normalizeGeminiCliModelForAgy` and the normalization unit test.

2. **Step 3 (implementation)**
   - Replaced the model catalog with AGY labels only.
   - Added legacy-ID set and normalization function with default fallback.
   - Preserved provider id `google-gemini-cli` and legacy static catalog structure as `ModelSpec[]`.

3. **Step 4 (verification)**
   - Ran focused suite: `npm test -- --runInBand tests/unit/GoogleGeminiCliAdapter.test.ts`.
   - Result after implementation: all 5 tests in the focused file pass.

## Files changed
- `src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliModels.ts`
- `tests/unit/GoogleGeminiCliAdapter.test.ts`
- `.superpowers/sdd/task-2-report.md`

## Self-review
- Confirmed the runtime adapter execution path was not modified.
- Confirmed only AGY labels are now present in `GOOGLE_GEMINI_CLI_MODELS`.
- Confirmed default model constant now points to `Gemini 3.5 Flash (Medium)`.
- Added normalization mapping for legacy Gemini CLI IDs to AGY default.
- Added explicit regression coverage for normalization.

## Concerns
- The brief’s provided model-list assertion includes a `model.provider` check, but `ModelInfo` in this codebase currently does not expose `provider`. I removed that assertion so the test aligns with the existing runtime contract.
