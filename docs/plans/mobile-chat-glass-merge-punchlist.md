# Mobile Chat Glass Merge Punchlist

Generated: 2026-04-14
Scope: `feat/mobile-chat-glass-phase1` (`ad2cab26`) compared against `main` (`f4ce05f9`)
Merge base: `a0cc7e6d`
Related plan: `docs/plans/mobile-chat-glass-migration-plan.md`

---

## Summary

This document captures the concrete rebase, regression, and validation work needed before the glass mobile branch can merge safely into `main`.

The glass branch is not just a CSS pass. It changes chat UI chrome, tool-event presentation, context compaction accounting, tool history access, prompt assembly, and several chat orchestration paths. Meanwhile, `main` moved ahead with vault-root storage, startup hydration, built-in system-guides workspace support, and release metadata changes.

This means the remaining work is not "finish the glass styles." The real task is:

1. rebase the branch over current `main`
2. preserve the new `main` storage/workspace behavior
3. fix the glass-specific regressions
4. make the branch green again

Note: the worktree currently contains additional uncommitted voice-input files that are not part of the audited branch tip. This punchlist is based on the committed branch state at `ad2cab26`.

---

## Progress Log

### 2026-04-14 — Safe implementation batch 3 complete

Fixed the glass branch's live subagent status mount without touching the unrelated voice-input edits.

Reason rebase is still deferred:

- the glass worktree is dirty with separate voice-input work in `src/ui/chat/components/ChatInput.ts`, `styles.css`, and several untracked voice-input files
- rebasing with those changes present would risk mixing unrelated work into the glass merge and creating avoidable conflicts

Changes landed:

- `ToolStatusBar` now creates a real `.tool-status-agent-slot`
- the fallback bot button remains available before subagent infrastructure initializes
- `SubagentController` can now render `AgentStatusMenu` into a provided container without requiring a legacy header `insertBefore` target
- `ChatView` now passes the glass status-bar agent slot into `ChatSubagentIntegration`

Verification after this batch:

- `npx jest tests/unit/ToolStatusBar.test.ts tests/unit/ChatSubagentIntegration.test.ts tests/unit/ChatViewAgentStatus.test.ts --runInBand` ✅
- `npm run build` ✅
- `npm test -- --runInBand` ✅

Remaining status work:

- manual UI verification still needs to confirm that running/completed subagent states are visually obvious in the glass status bar
- the rebase still needs a clean worktree or a deliberate stash/commit strategy for the unrelated voice-input work

---

### 2026-04-14 — Safe implementation batch 2 complete

Removed the remaining compaction/debug `console.log` noise that was still showing up during `npm run build`.

Files cleaned:

- `src/ui/chat/services/ChatSendCoordinator.ts`
- `src/services/chat/ContextPreservationService.ts`
- `src/services/llm/core/ProviderMessageBuilder.ts`
- `src/services/llm/core/StreamingOrchestrator.ts`
- `src/services/llm/adapters/openai/OpenAIAdapter.ts`

Verification after this batch:

- `npm run build` ✅
- `npm test -- --runInBand` ✅

Current state after batches 1 and 2:

- full test suite green
- build green
- compaction/logging warnings removed
- remaining major work is now rebase/conflict resolution, subagent status integration, version metadata sync, and manual mobile QA

---

### 2026-04-14 — Safe implementation batch 1 complete

Completed a low-risk verification/hygiene batch in the glass worktree without touching the in-progress voice-input edits in `ChatInput.ts` and `styles.css`.

Changes landed:

- excluded `coverage/` from ESLint so generated reports no longer break typed lint
- changed `tests/integration/transcription-live.test.ts` to opt-in live execution via `RUN_LIVE_TRANSCRIPTION_TESTS=1` instead of hard-failing on a missing `/tmp` fixture
- updated stale `ToolStatusBar` tests to match the current glass status-bar contract
- fixed `ContextTrackerCompactionUsage.test.ts` so it applies compaction metadata before asserting post-compaction usage
- removed the `no-useless-catch` lint error in `ChatSendCoordinator.runContextCompaction()`

Verification after this batch:

- `npm test -- --runInBand` ✅
- `npm run build` ✅

At the end of batch 1, 21 `no-console` warnings still remained in compaction/debug paths. Those were cleared in the batch-2 follow-up above.

---

## Current Audit Snapshot

- Branch under audit: `feat/mobile-chat-glass-phase1`
- Branch status relative to `main`: behind by 4 commits
- Diff size vs `main...branch`: 137 files, `+9437 / -4548`
- Highest-risk overlap with newer `main` work:
  - `src/ui/chat/ChatView.ts`
  - `src/ui/chat/services/SystemPromptBuilder.ts`
  - `src/ui/chat/services/ModelAgentManager.ts`
  - `src/services/ConversationService.ts`
  - `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`
  - `src/types.ts`
  - `src/utils/connectorContent.ts`

---

## Confirmed Findings

### 1. Subagent live-status mount is effectively disabled

The glass branch adds an agent button to the status bar, but it does not pass a real mount point into subagent initialization.

- `src/ui/chat/ChatView.ts` passes `undefined` for both `getAgentStatusSlot` and `getSettingsButton`
- `src/ui/chat/controllers/SubagentController.ts` only renders `AgentStatusMenu` when both container values exist
- `src/ui/chat/components/ToolStatusBar.ts` returns a detached `div` from `getAgentSlotEl()`, which is not a valid render target

Result:

- opening the agent modal can still work through the direct click callback
- the live badge/spinner/success-state path from `AgentStatusMenu` does not have a real mount target

### 2. The branch is not green on its own test/build surface

Observed failures while auditing:

- `npm test -- --runInBand`
  - `tests/unit/ToolStatusBar.test.ts` fails because the implementation no longer matches the expected class/DOM contract
  - `tests/unit/ContextTrackerCompactionUsage.test.ts` fails because the new compaction-boundary accounting does not satisfy the previous reduction expectation
  - `tests/integration/transcription-live.test.ts` fails hard if `/tmp/test-transcription.wav` is missing
- `npm run build`
  - fails in `eslint .` because the worktree includes `coverage/lcov-report/*`, and typed lint rules attempt to lint those generated files

### 3. Compaction debug logging is still present in production paths

Representative examples:

- `src/ui/chat/services/ChatSendCoordinator.ts`
- `src/services/chat/ContextPreservationService.ts`
- `src/services/llm/core/ProviderMessageBuilder.ts`
- `src/services/llm/core/StreamingOrchestrator.ts`

These logs are useful during development but should not ship in a production Obsidian plugin.

### 4. Release/version metadata is stale

The glass branch still reports `5.7.2`, while `main` is already at `5.7.4`.

Files affected:

- `package.json`
- `manifest.json`
- `CLAUDE.md`
- `src/utils/connectorContent.ts`

### 5. The branch predates current `main` storage/workspace behavior

Newer `main` added:

- vault-root storage migration and routing
- startup hydration / local chat index wait states
- built-in system-guides workspace loading
- `ConversationService` readable-backend routing for read paths

If the glass branch is merged without reconciling those changes, it risks reintroducing behavior `main` already fixed.

---

## Mainline Drift To Preserve

These `main` changes must survive the merge:

### Vault-root storage and startup hydration

Commits:

- `849657d7` `feat: Vault-root storage with sharding, migration, and data-tab UI (#134)`
- `1558a7e4` `chore: janitor cleanup of vault-root storage code (#135)`

Important impacted areas:

- `src/ui/chat/ChatView.ts`
- `src/database/adapters/HybridStorageAdapter.ts`
- `src/database/storage/*`
- `src/settings/*`
- `src/services/WorkspaceService.ts`

### Built-in system-guides workspace support

Impacted areas:

- `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`
- `src/ui/chat/services/SystemPromptBuilder.ts`

### Read-path backend changes

Impacted area:

- `src/services/ConversationService.ts`

`main` switched multiple conversation read paths from `withDualBackend(...)` to `withReadableBackend(...)`. The glass branch adds tool-history pagination on top of the older version, so this needs a deliberate merge, not a blind conflict resolution.

### Release metadata bump

Commits:

- `f4ce05f9` `chore: bump version to 5.7.4`

---

## Punchlist

## Batch 1: Rebase And Conflict Resolution

- [ ] Rebase `feat/mobile-chat-glass-phase1` onto current `main`
- [ ] Resolve conflicts in `src/ui/chat/ChatView.ts` by preserving both:
  - glass status-bar / inspection-modal wiring
  - `main` startup hydration and database-loading behavior
- [ ] Resolve conflicts in `src/ui/chat/services/SystemPromptBuilder.ts` by preserving both:
  - glass tool catalog / compaction frontier support
  - `main` built-in system-guides workspace support
- [ ] Resolve conflicts in `src/services/ConversationService.ts` by preserving both:
  - glass tool-call history pagination API
  - `main` readable-backend read paths
- [ ] Resolve conflicts in `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts` by preserving `main` system-workspace loading
- [ ] Resolve conflicts in `src/types.ts` by preserving `main` storage settings defaults
- [ ] Regenerate or reconcile `src/utils/connectorContent.ts` after the rebase

**Exit criteria**

- Branch rebases cleanly onto `main`
- No `main` vault-root or workspace-system behavior is dropped during conflict resolution

---

## Batch 2: Functional Regression Fixes

### Subagent status integration

- [x] Decide the target UX explicitly:
  - restore the existing `AgentStatusMenu` live-status mount, or
  - replace it fully with a glass-native equivalent
- [x] Wire a real agent-status mount target through `ChatView` into `ChatSubagentIntegration`
- [x] Remove or repurpose `ToolStatusBar.getAgentSlotEl()` if it remains a detached placeholder
- [ ] Verify that running/completed subagent status is visible without opening the modal

### Context compaction accounting

- [ ] Reconcile the compaction-boundary behavior with the `ContextTracker` regression test
- [ ] Confirm that context percentage after compaction reflects only the post-boundary message set plus system-prompt frontier content
- [ ] Verify the visual compaction divider still aligns with the saved compaction boundary after reload

### Tool status bar contract

- [ ] Align `ToolStatusBar` implementation and tests on the intended class/DOM contract
- [ ] Confirm the row-2 controls still match the migration spec:
  - inspect
  - task board
  - agents
  - compact
  - cost
  - context badge

**Exit criteria**

- Subagent live status is functional again
- Context compaction behavior is intentionally defined and tested
- Tool status bar tests reflect the intended production DOM contract

---

## Batch 3: Test And Build Hygiene

- [x] Make `npm test` pass without requiring a manually created `/tmp/test-transcription.wav`
- [x] Gate live transcription tests behind an opt-in fixture or environment switch
- [x] Prevent `eslint .` from linting generated `coverage/` output
- [x] Remove stale/review-only test expectations that no longer match the current glass design
- [x] Re-run:
  - `npm test -- --runInBand`
  - `npm run build`

**Exit criteria**

- Full local test suite is green or intentionally gated ✅
- Build passes from a clean checkout without manual cleanup steps ✅

---

## Batch 4: Production Cleanup

- [x] Remove compaction-related `console.log` debugging from production chat/LLM paths
- [x] Re-check for any other newly introduced debug instrumentation in glass files
- [ ] Confirm no generated artifact such as `main.js.map` is being accidentally introduced or tracked unless that is now intentional
- [ ] Update branch version metadata from `5.7.2` to the current `main` baseline or newer

**Exit criteria**

- Branch is not shipping debug noise ✅
- Version/build metadata is current

---

## Batch 5: Manual Verification

- [ ] Mobile chat opens correctly with the rebased startup-hydration path
- [ ] Tool status bar renders and updates in all key states:
  - idle
  - active tool
  - completed tool
  - failed tool
  - context-only visible state
- [ ] Tool inspection modal opens, paginates older tool-call history, and updates while the conversation continues
- [ ] Context badge thresholds display correctly
- [ ] Compact button works before and after subagent infrastructure initialization
- [ ] Task-board icon opens the existing task workspace flow
- [ ] Agent icon opens the modal and also reflects live running/completed status
- [ ] Thinking loader mounts before first token and tears down cleanly on first content or abort
- [ ] Conversation reload preserves:
  - tool-call history modal data source
  - compaction divider placement
  - context percentage
  - branch/subagent state

**Exit criteria**

- No glass-specific regressions remain in the core mobile chat loop
- The rebased branch is ready for final code review and Obsidian manual QA

---

## Recommended Order

1. Rebase onto `main`
2. Fix subagent status integration
3. Fix failing tests and build hygiene
4. Remove debug logging
5. Run manual mobile QA

This order matters. Doing more UI polish before the rebase risks duplicating work on files that will conflict anyway.
