# Task 4 Report: Replace adapter execution with `agy --print`

## Summary

Reworked `GoogleGeminiCliAdapter` so the legacy `google-gemini-cli` provider now runs through AGY instead of the Gemini CLI runtime path.

## TDD Evidence

### Red

Ran the focused adapter test before the implementation:

```bash
npm test -- --runInBand tests/unit/GoogleGeminiCliAdapter.test.ts
```

Observed failures because the adapter still resolved the Gemini CLI runtime path and hit `resolveGeminiCliRuntime` / `FileSystemAdapter instanceof` at runtime.

### Green

After the implementation swap, reran the same focused test:

```bash
npm test -- --runInBand tests/unit/GoogleGeminiCliAdapter.test.ts
```

Result: `PASS` for all 8 tests in `tests/unit/GoogleGeminiCliAdapter.test.ts`.

## Files Changed

- `src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts`
- `tests/unit/GoogleGeminiCliAdapter.test.ts`

## What Changed

- Replaced Gemini CLI execution with `agy --print --dangerously-skip-permissions --print-timeout 5m --model <agyLabel>`.
- Kept prompt content on stdin via `stdinText`.
- Removed the temporary Gemini system-settings file path.
- Switched runtime resolution and environment setup to AGY utilities.
- Preserved provider id/name `google-gemini-cli`.
- Kept stdout parsing compatible with plain text and JSON-shaped output.
- Updated capability metadata to reflect AGY/Antigravity CLI support.
- Rewrote adapter tests to assert AGY invocation, model normalization, JSON output parsing, and missing-AGY failure handling.

## Self-Review

- The adapter no longer references the Gemini CLI runtime path or temp settings file creation.
- The command args match the task brief exactly.
- The focused test covers the new execution path and the legacy model normalization behavior.
- The change is scoped to the adapter and its unit test.

## Concerns

- I did not run the full suite because the repository already has a known unrelated failure in `tests/unit/TaskBoardEditCoordinator.test.ts` from an undefined `ConfirmModal` mock.
- I did not edit unrelated files, including `.nvmrc` or the AGY/auth utility files referenced in the task constraints.
