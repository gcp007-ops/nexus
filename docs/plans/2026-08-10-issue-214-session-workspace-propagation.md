# Issue #214 Session Workspace Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `getTools`/`useTools` callers to omit `workspaceId` after establishing a friendly session handle while preserving the session's canonical workspace through batch execution and traces.

**Architecture:** `SessionContextManager` remains the authority that binds a friendly handle to an internal session and workspace. It will return that effective workspace with every validation result, resolve an omitted workspace only when the handle is unique across workspaces, and reject ambiguity. `ToolExecutionStrategy` will copy the validated workspace into the raw ToolManager meta-tool envelope before `UseToolTool` normalizes it, so the batch context, nested tool params, and response callback all observe the same workspace.

**Tech Stack:** TypeScript, Jest, MCP request strategy, Nexus ToolManager CLI normalizer.

## Global Constraints

- Base: `fork/main` at Nexus 5.16.3 (`b29f4d95`).
- `workspaceId` is optional in ToolManager schemas and TypeScript inputs.
- An explicit workspace always scopes friendly-handle resolution.
- An omitted workspace may inherit only a unique friendly-handle binding; ambiguity fails closed and executes no tool.
- No blind port of commits `b6d6587c` or `b8f07373`; they are evidence only.
- Preserve mobile compatibility and add no dependencies.
- Do not publish, deploy, apply, reload, or modify ThinkBox.
- Preserve the known baseline `LocalCliInstaller` Windows simulation failure; it is out of scope.

---

### Task 1: Pin the ToolManager schema contract

**Files:**
- Create: `tests/unit/ToolManagerSessionWorkspacePropagation.test.ts`
- Modify: `tests/eval/headless/headless.smoke.test.ts`
- Modify: `tests/eval/fixtures/tools.ts`
- Modify: `src/agents/toolManager/tools/getTools.ts`
- Modify: `src/agents/toolManager/tools/useTools.ts`
- Modify: `src/agents/toolManager/types.ts`

**Interfaces:**
- Consumes: `GetToolsTool.getParameterSchema()`, `UseToolTool.getParameterSchema()`, `getTopLevelToolContextSchema()`.
- Produces: schemas where `required` excludes `workspaceId` and descriptions explain session inheritance without nudging callers to `default`.

- [x] **Step 1: Write the failing schema tests**

Add literal assertions that both meta-tool schemas omit `workspaceId` from `required`, and that the shared context schema describes session-based inheritance rather than unconditional defaulting.

- [x] **Step 2: Run the schema tests and verify RED**

Run: `npm test -- --runInBand tests/unit/ToolManagerSessionWorkspacePropagation.test.ts`

Expected: FAIL because Nexus 5.16.3 still requires `workspaceId` in both schemas and describes omission as defaulting to `default`.

- [x] **Step 3: Implement the minimal schema change**

Remove `workspaceId` from the two `required` arrays and update only ToolManager-facing examples/descriptions to state that callers establish a workspace once and may omit it on later calls using the same session handle.

- [x] **Step 4: Run the schema tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/ToolManagerSessionWorkspacePropagation.test.ts`

Expected: PASS.

### Task 2: Resolve omitted friendly handles without ambiguity

**Files:**
- Modify: `tests/unit/SessionContextManager.test.ts`
- Modify: `src/services/SessionContextManager.ts`

**Interfaces:**
- Consumes: `validateSessionId(sessionId, description, workspaceId?)` and the workspace-partitioned friendly-handle map.
- Produces: `SessionValidationResult.effectiveWorkspaceId: string`; unique cross-workspace reuse; an exported ambiguity error that carries no fallback workspace.

- [x] **Step 1: Write failing session-resolution tests**

Cover four observable behaviors: explicit workspace results expose that workspace; omitted workspace reuses a uniquely bound handle and ID; duplicate handles in two workspaces reject rather than create a third session under `default`; blank workspace is treated as omitted.

- [x] **Step 2: Run the session tests and verify RED**

Run: `npm test -- --runInBand tests/unit/SessionContextManager.test.ts`

Expected: FAIL because the current result has no `effectiveWorkspaceId`, omission defaults immediately to `default`, and duplicate handles do not reject.

- [x] **Step 3: Implement minimal unique resolution**

Normalize blank workspace input to omitted. For an explicit workspace, use the existing partitioned lookup. For omission, scan exact reconstructed handle keys, deduplicate the paired input/display entries by object identity, return the sole match, and throw the dedicated ambiguity error when more than one distinct session owns the handle. New unknown handles continue to be created under `default`.

- [x] **Step 4: Return the effective workspace on every validation branch**

Populate `effectiveWorkspaceId` from the handle entry, existing session row, bound session context, explicit workspace, or `default` fallback as appropriate.

- [x] **Step 5: Run the session tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/SessionContextManager.test.ts tests/unit/connector.session.test.ts`

Expected: PASS.

### Task 3: Propagate the validated workspace before ToolManager normalization

**Files:**
- Modify: `tests/unit/ToolExecutionStrategy.buildRequestContext.test.ts`
- Modify: `src/handlers/strategies/ToolExecutionStrategy.ts`

**Interfaces:**
- Consumes: `SessionValidationResult.effectiveWorkspaceId`.
- Produces: raw ToolManager params with canonical top-level `workspaceId` before parameter validation and execution; ambiguity bypasses the legacy fallback and executes nothing.

- [x] **Step 1: Write failing request-boundary tests**

Add one test where `toolManager_useTools` omits `workspaceId` and session validation returns `ws-inherited`; assert the executed raw ToolManager params and response callback both carry `ws-inherited`. Add one ambiguity test asserting `SessionService.processSessionId` and `executeAgent` are not called.

- [x] **Step 2: Run the request-boundary tests and verify RED**

Run: `npm test -- --runInBand tests/unit/ToolExecutionStrategy.buildRequestContext.test.ts`

Expected: FAIL because current params remain workspace-less and all session-validation errors fall back to the legacy session service.

- [x] **Step 3: Implement minimal propagation and fail-closed routing**

After successful session validation, assign `validationResult.effectiveWorkspaceId` to top-level `params.workspaceId` for ToolManager meta-tools before `processParameters()`. Re-throw the dedicated ambiguity error instead of entering the legacy fallback; preserve fallback behavior for unrelated validation failures.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/ToolExecutionStrategy.buildRequestContext.test.ts tests/unit/SessionContextManager.test.ts tests/unit/connector.session.test.ts tests/unit/ToolManagerSessionWorkspacePropagation.test.ts tests/unit/ToolBatchExecutionService.test.ts`

Expected: PASS.

### Task 4: Verify and commit the isolated patch

**Files:**
- Verify all files listed above.

**Interfaces:**
- Consumes: completed patch and regression suite.
- Produces: intentional commits on `fix/mcp-session-workspace-propagation-5163` with no unrelated changes.

- [ ] **Step 1: Run static and build verification**

Run: `npm run build`

Run: `npm run lint -- --no-fix`

Expected: both exit 0.

- [ ] **Step 2: Run proportional regression tests**

Run: `npm test -- --runInBand --testPathIgnorePatterns=ModelAgentManager`

Expected: all relevant tests pass; if the known `LocalCliInstaller` Windows simulation failure appears, record it as unchanged baseline rather than modifying it.

- [ ] **Step 3: Inspect the patch**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat fork/main...HEAD`

Expected: only the plan, ToolManager/session/request-boundary production files, and their tests are present.

- [ ] **Step 4: Commit intentionally**

Commit the plan/tests and implementation with messages scoped to issue #214. Do not push.
