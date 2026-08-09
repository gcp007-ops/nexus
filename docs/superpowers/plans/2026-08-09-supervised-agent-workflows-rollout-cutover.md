# Supervised Agent Workflows Rollout and Cutover Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and validate the Nexus/ThinkBox supervised workflow stack, create `VaultHygiene-Agentico`, prove one controlled cycle, and remove legacy autoarchive code only after parity.

**Architecture:** Publication, deploy, reload, live configuration, read-only execution, fixture application, real application, and legacy removal are independent gates. Every live mutation requires exact preflight and readback; ambiguous process or apply state is never retried automatically.

**Tech Stack:** Git, GitHub CLI, Nexus/ThinkBox Obsidian plugins, Nexus CLI, Claude CLI, Jest, Vitest.

## Global Constraints

- This plan starts only after both implementation plans pass complete tests and builds.
- Git publication for each repository requires explicit authorization.
- Nexus deploy/reload and ThinkBox deploy/reload require separate explicit authorization.
- Live prompt/workflow creation is a vault mutation and requires explicit authorization.
- Scheduled execution remains disabled through initial acceptance.
- The first live Claude run is proposal-only.
- The first apply uses reversible fixtures, not production notes.
- No ambiguous external/process/apply result is retried.
- Legacy deletion begins only after a real supervised cycle and explicit cutover authorization.

---

### Task 1: Publish Nexus and stop before deploy

**Files:** Nexus implementation branch only.

- [ ] **Step 1: Re-run Nexus complete verification**

Run: `npm test -- --runInBand`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Confirm branch scope and remote base**

Run: `git status --short --branch`, `git log --oneline <base>..HEAD`, and
`git diff --stat <base>...HEAD`.

Expected: intentional Nexus runtime commits only.

- [ ] **Step 3: Obtain publication authorization**

Stop unless the user explicitly authorizes commit reconciliation, push, and PR.

- [ ] **Step 4: Push and open PR**

Push the exact feature branch and open one Nexus PR summarizing security boundary,
non-blocking startup, tests, and the no-deploy state.

- [ ] **Step 5: Read back PR and checks**

Confirm remote head SHA, changed files, CI checks, and unresolved review threads.
Do not merge or deploy under publication-only authorization.

---

### Task 2: Deploy and reload Nexus under separate authorization

- [ ] **Step 1: Obtain deploy authorization and capture installed baseline**

Read installed Nexus version and bundle hashes; record enabled state and create a
recoverable plugin backup.

- [ ] **Step 2: Deploy the reviewed Nexus SHA**

Use the repository's approved deploy path. Record source SHA and installed bundle
hashes.

- [ ] **Step 3: Obtain reload authorization**

Do not infer reload permission from deploy permission.

- [ ] **Step 4: Reload only Nexus and read back health**

Confirm UI responsiveness, service availability, `supervisedWorkflowService`,
Agent runs view, and absence of a Claude process or queued workflow at startup.

---

### Task 3: Create the live prompt and workflow

**Files:** live Nexus prompt/workspace data through Nexus tools only.

- [ ] **Step 1: Obtain live configuration authorization**

Show exact prompt name, description, workflow name, workspace, execution block,
and disabled schedule before mutation.

- [ ] **Step 2: Check for existing identities**

Use `prompt list/get` and `memory load-workspace`. If a matching prompt or
workflow exists, compare and update intentionally; do not create a duplicate.

- [ ] **Step 3: Create or update `Guardiao da Vault`**

The prompt must require `CLAUDE.md`, workspace load, applicable routing/skills,
authority resolution, evidence, strict read-only behavior, and exactly one
`vault-change-plan/v1` output.

- [ ] **Step 4: Create or update `VaultHygiene-Agentico`**

Bind the prompt in workspace `Desenvolvedor` and set:

```yaml
execution:
  backend: claude-cli
  model: sonnet
  mode: proposal
  capabilityProfile: vault-readonly
  outputSchema: vault-change-plan/v1
  maxTurns: 12
  timeoutMinutes: 10
  approvalRequired: true
```

Omit the optional `schedule` field so scheduling remains disabled.

- [ ] **Step 5: Read back prompt and workspace**

Confirm stable IDs, exact execution config, schedule disabled, and prompt/workflow
binding. Record hashes reported by Nexus.

---

### Task 4: Run a real read-only proposal

- [ ] **Step 1: Capture preflight**

Confirm Claude path, Node path, local authentication, connector/proxy readiness,
workspace, prompt/workflow hashes, and zero active duplicate run.

- [ ] **Step 2: Start one manual run**

Start via Nexus or ThinkBox once. Capture returned `runId`; do not repeat on UI
delay or temporary uncertainty.

- [ ] **Step 3: Observe to a terminal proposal state**

Expected: `awaiting_approval`. Acceptable failure states are reported without
retry. Confirm no mutation tool call occurred and capability traces contain only
allowed read-only pairs.

- [ ] **Step 4: Validate the plan without applying**

Confirm schema, hashes, evidence, four-operation allowlist, recommendations,
paths, dependencies and preservation notes. Reject the run if any identity or
scope is wrong.

---

### Task 5: Publish, deploy, and reload ThinkBox under separate gates

- [ ] **Step 1: Re-run ThinkBox complete verification**

Run: `npm test`

Expected: exit 0.

Run: `npx tsc --noEmit`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Obtain publication authorization, then push and open PR**

Read back remote SHA, file scope, checks, and review state. Stop before merge or
deploy unless explicitly authorized.

- [ ] **Step 3: Obtain deploy authorization and capture baseline**

Record installed ThinkBox version/hash and create a recoverable plugin backup.

- [ ] **Step 4: Deploy reviewed ThinkBox SHA**

Record source and installed hashes. Do not reload implicitly.

- [ ] **Step 5: Obtain reload authorization and reload only ThinkBox**

Confirm UI responsiveness, no slow-plugin warning, no startup call to Nexus
supervised workflows, and no Claude process.

- [ ] **Step 6: Open the cockpit and read back the existing run**

Expected: same `runId`, plan hash, workflow identity and operation/recommendation
counts as Nexus. No duplicate plan is created.

---

### Task 6: Apply only reversible fixtures

- [ ] **Step 1: Create an isolated fixture scope with explicit authorization**

Use disposable notes under an approved test folder covering `move`, `archive`,
`setProperty`, and `replaceAnchored`. Capture initial content hashes and paths.

- [ ] **Step 2: Run a fixture-focused proposal**

Confirm the plan references only fixture paths. Reject any operation outside the
fixture root.

- [ ] **Step 3: Approve all four fixture operations once**

Capture `runId`, `planHash`, selected operation IDs and the exact confirmation
summary before applying.

- [ ] **Step 4: Read back every operation**

Confirm terminal status, target state, source absence/preservation as applicable,
conversation events and no automatic retry.

- [ ] **Step 5: Exercise stale and rollback paths on fresh fixtures**

Change one fixture after planning to prove `stale`. Induce one controlled
readback failure through the test harness to prove operation-local rollback.

---

### Task 7: Prove one real supervised hygiene cycle

- [ ] **Step 1: Obtain explicit production-vault apply authorization**

Present operation IDs, paths, types, evidence, expected effects, dependencies,
rollback and total counts. Recommendations remain non-applicable.

- [ ] **Step 2: Apply only selected operations once**

Do not retry an ambiguous result. Observe the authoritative run until terminal.

- [ ] **Step 3: Perform independent readback**

Read every affected path and conversation event. Confirm hashes, operation
results, readback, absence of unselected effects, and unchanged schedule state.

- [ ] **Step 4: Record acceptance evidence**

Record startup behavior, run identity, plan hash, selected operations, results,
rollbacks if any, and remaining recommendations in the governing initiative.

---

### Task 8: Remove absorbed ThinkBox autoarchive code after cutover authorization

**Files:**
- Delete when proven unused: `src/auto-archive/manual-attempt.ts`
- Delete when proven unused: `src/auto-archive/controller.ts`
- Delete when proven unused: `src/auto-archive/planner-runner.ts`
- Delete when proven unused: `src/auto-archive/modal.ts`
- Modify: `src/auto-archive/index.ts`
- Modify: `src/main.ts`
- Modify: `src/settings-tab.ts`
- Modify: `styles.css`
- Delete or rewrite corresponding `tests/auto-archive/*` files only after a consumer inventory.

- [ ] **Step 1: Obtain explicit legacy-removal authorization**

Provide evidence from Tasks 4, 6, and 7 and an `rg` inventory of every legacy
export/import/call site. Stop if an exclusive consumer remains.

- [ ] **Step 2: Write failing absence and routing tests**

```ts
expect(mainSource).not.toContain('ManualAttemptCoordinator');
expect(mainSource).not.toContain('createAutoArchiveController');
expect(commandBody('tb-autoarchive-open')).toContain('VaultHygiene-Agentico');
expect(onloadBody).not.toContain('autoarchive-plan');
```

- [ ] **Step 3: Remove only absorbed decision and UI code**

Preserve factual scanners still consumed by `VaultHygiene-Agentico` evidence.
Archive live rules/scripts through the applicable vault workflow; do not delete
history from Git or the vault.

- [ ] **Step 4: Run ThinkBox focused and complete verification**

Run: `npm test -- tests/supervised-agents tests/auto-archive tests/internal-modules`.

Expected: PASS after tests are intentionally reassigned or removed with their
production units.

Run: `npm test`

Expected: exit 0.

Run: `npx tsc --noEmit`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Review the deletion diff and stop at publication**

Confirm no factual scanner, archive safety primitive, unrelated triage path, or
historical record was removed. Publication and redeploy require new explicit
authorization.
