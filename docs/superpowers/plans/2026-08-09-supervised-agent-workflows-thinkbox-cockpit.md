# ThinkBox Supervised Agent Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic ThinkBox cockpit that launches, reviews, approves, and observes Nexus supervised workflow runs without owning process execution or duplicate state.

**Architecture:** A narrow Nexus adapter resolves `supervisedWorkflowService`; a local controller holds only modal presentation state and polls authoritative run DTOs. The UI renders applicable operations and recommendations, confirms exact selections, and forwards approval to Nexus.

**Tech Stack:** TypeScript, Obsidian Plugin API, Vitest, Nexus public plugin service, CSS theme variables.

## Global Constraints

- Requires the completed Nexus runtime plan and public `supervisedWorkflowService` contract.
- ThinkBox never spawns Claude CLI and never persists a duplicate run or plan.
- No agent workflow starts during ThinkBox `onload()`.
- Closing UI does not cancel a run; cancellation is explicit.
- Only the four Nexus operation DTOs are rendered as applicable.
- Recommendations and validator rejections have no apply control.
- Production UI starts only after Nexus runtime Task 7's shared mockup is
  approved; ThinkBox implements that approved cockpit surface.
- All styles live in `styles.css`; use registered DOM events.
- Publication, deploy, reload, live prompt/workflow creation, and legacy deletion remain separate gates.

---

### Task 1: Nexus supervised-workflow adapter

**Files:**
- Create: `src/supervised-agents/types.ts`
- Create: `src/supervised-agents/nexus-adapter.ts`
- Create: `src/supervised-agents/index.ts`
- Create: `tests/supervised-agents/nexus-adapter.test.ts`

**Interfaces:**
- Consumes: Nexus `supervisedWorkflowService` from runtime Task 8.
- Produces: `resolveSupervisedWorkflowService(app)` returning the exact narrow interface used by ThinkBox.

- [ ] **Step 1: Write failing adapter tests**

```ts
it.each(['nexus', 'nexus-thinkbox', 'claudesidian-mcp'])('resolves %s', async id => {
  const service = fakeService();
  const app = appWithPlugin(id, pluginWithService(service));
  await expect(resolveSupervisedWorkflowService(app)).resolves.toBe(service);
});

it('fails clearly while Nexus is unavailable or initializing', async () => {
  await expect(resolveSupervisedWorkflowService(appWithoutNexus()))
    .rejects.toThrow('Nexus supervised workflow service is unavailable');
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/supervised-agents/nexus-adapter.test.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Define DTOs and implement service resolution**

Mirror only stable DTO fields needed by ThinkBox. Resolve through `getService`,
`getServiceIfReady`, then `getServiceContainer`; do not use `any` in the new
module and do not fall back to AgentManager or direct CLI execution.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/supervised-agents/nexus-adapter.test.ts`

Expected: PASS.

```bash
git add src/supervised-agents/types.ts src/supervised-agents/nexus-adapter.ts src/supervised-agents/index.ts tests/supervised-agents/nexus-adapter.test.ts
git commit -m "feat: connect supervised Nexus workflows"
```

---

### Task 2: Non-blocking cockpit controller

**Files:**
- Create: `src/supervised-agents/controller.ts`
- Create: `tests/supervised-agents/controller.test.ts`

**Interfaces:**
- Consumes: Task 1 adapter.
- Produces: `createSupervisedAgentController(deps)` with `list`, `preflight`, `start`, `refresh`, `cancel`, `approve`, and `stopPolling`.
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('returns runId without awaiting run completion', async () => {
  service.start.mockResolvedValue({ runId: 'run-1' });
  await expect(controller.start('ws-1', 'wf-1')).resolves.toEqual({ runId: 'run-1' });
});

it('closing presentation polling does not cancel the run', () => {
  controller.stopPolling();
  expect(service.cancel).not.toHaveBeenCalled();
});

it('cancel is explicit and coalesced', async () => {
  await Promise.all([controller.cancel('run-1'), controller.cancel('run-1')]);
  expect(service.cancel).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/supervised-agents/controller.test.ts`

Expected: FAIL because the controller is absent.

- [ ] **Step 3: Implement presentation-only state**

Use one poll timer registered/disposed by the modal owner. The controller stores
only current `runId`, last fetched DTO, and in-flight request promises. It never
copies the plan to machine state and never starts work automatically.

- [ ] **Step 4: Cover terminal states and stale responses**

Add tests for Nexus disappearance, an older poll resolving after a newer poll,
terminal-state polling stop, and approval forwarding exact `runId`, `planHash`,
and selected operation IDs.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/supervised-agents/controller.test.ts`

Expected: PASS.

```bash
git add src/supervised-agents/controller.ts tests/supervised-agents/controller.test.ts
git commit -m "feat: coordinate supervised agent runs"
```

---

### Task 3: Generic run and approval modal

**Files:**
- Create: `src/supervised-agents/modal.ts`
- Modify: `styles.css`
- Create: `tests/supervised-agents/modal.test.ts`
- Create: `tests/supervised-agents/styles-coverage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 DTOs/controller.
- Produces: `SupervisedAgentModal` for workflow selection, progress, review, exact confirmation, application, and readback.

- [ ] **Step 1: Write failing render tests**

```ts
expect(renderRun(awaitingApprovalRun()).querySelectorAll('[data-operation-id]')).toHaveLength(4);
expect(textForRecommendation()).toContain('Recommendation only');
expect(recommendationApplyButton()).toBeNull();
expect(rejectedOperationApplyButton()).toBeNull();
```

- [ ] **Step 2: Write failing exact-confirmation tests**

```ts
selectOperations(['move-1', 'property-1']);
clickReviewApproval();
expect(confirmationText()).toContain('1 move');
expect(confirmationText()).toContain('1 property update');
expect(confirmationText()).toContain('2 operations not selected');
expect(service.approveAndApply).not.toHaveBeenCalled();
clickConfirm();
expect(service.approveAndApply).toHaveBeenCalledWith({
  runId: 'run-1', planHash: 'sha256:plan', operationIds: ['move-1', 'property-1'],
  approval: { kind: 'human', source: 'thinkbox', confirmedAt: NOW }
});
```

- [ ] **Step 3: Run and confirm RED**

Run: `npm test -- tests/supervised-agents/modal.test.ts`

Expected: FAIL because the modal is absent.

- [ ] **Step 4: Implement modal stages**

Implement `workflow`, `running`, `review`, `confirm`, and `result` stages. Render
evidence, before/after state, paths, preconditions, risk, dependencies, rollback,
recommendations, validator rejections, trace details, and per-operation readback.
Use textContent/createEl and registered DOM events only.

- [ ] **Step 5: Add accessibility and CSS coverage**

Buttons require accessible names, focus-visible styles, and disabled state during
requests. Use Obsidian CSS variables and no inline style assignment. The coverage
test must ensure every literal `tb-supervised-*` class has a stylesheet selector.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- tests/supervised-agents/modal.test.ts tests/supervised-agents/styles-coverage.test.ts`

Expected: PASS.

```bash
git add src/supervised-agents/modal.ts styles.css tests/supervised-agents/modal.test.ts tests/supervised-agents/styles-coverage.test.ts
git commit -m "feat: review supervised agent plans"
```

---

### Task 4: Settings, commands, and temporary autoarchive routing

**Files:**
- Modify: `src/main.ts`
- Modify: `src/settings-tab.ts`
- Modify: `src/internal-modules/autoarquivamento-assistido/module.ts`
- Modify: `tests/internal-modules/main-wiring-source.test.ts`
- Modify: `tests/internal-modules/settings-wiring-source.test.ts`
- Create: `tests/supervised-agents/startup-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `ThinkBox: Abrir agentes supervisionados` and temporary compatibility routing from `ThinkBox: Abrir Limpeza assistida`.

- [ ] **Step 1: Write failing source-wiring tests**

```ts
expect(onloadBody).not.toContain('startSupervisedWorkflow');
expect(onloadBody).not.toContain('listWorkflows');
expect(commandBody('tb-supervised-agents-open')).toContain('openSupervisedAgents');
expect(commandBody('tb-autoarchive-open')).toContain('VaultHygiene-Agentico');
expect(commandBody('tb-autoarchive-open')).toContain('listWorkflows');
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/supervised-agents/startup-wiring.test.ts tests/internal-modules/main-wiring-source.test.ts tests/internal-modules/settings-wiring-source.test.ts`

Expected: FAIL because commands and settings are absent.

- [ ] **Step 3: Add manual-only entry points**

Instantiate the controller/modal only inside explicit command/button callbacks.
Add a settings section that lists compatible workflows after user interaction,
shows readiness and last run, and offers `Configure in Nexus` and `Open run in
Nexus`. Do not edit prompt/model/schedule in ThinkBox.

- [ ] **Step 4: Route the old command without removing legacy code**

The compatibility command calls Nexus `VaultHygiene-Agentico` with an archive
focus input supported by the public service. If Nexus lacks the workflow, show a
clear notice and leave the legacy controller dormant; do not silently run the old
planner.

- [ ] **Step 5: Handle plugin unload**

Dispose polling and modal presentation only. Do not cancel a Nexus run unless the
user pressed the explicit cancel action.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- tests/supervised-agents tests/internal-modules/main-wiring-source.test.ts tests/internal-modules/settings-wiring-source.test.ts`

Expected: PASS.

```bash
git add src/main.ts src/settings-tab.ts src/internal-modules/autoarquivamento-assistido/module.ts tests/supervised-agents/startup-wiring.test.ts tests/internal-modules/main-wiring-source.test.ts tests/internal-modules/settings-wiring-source.test.ts
git commit -m "feat: add supervised agents cockpit"
```

---

### Task 5: ThinkBox integration verification

**Files:**
- Modify only when verification exposes a defect within Tasks 1–4.

- [ ] **Step 1: Run all new and affected tests**

Run: `npm test -- tests/supervised-agents tests/internal-modules/main-wiring-source.test.ts tests/internal-modules/settings-wiring-source.test.ts tests/auto-archive`

Expected: PASS.

- [ ] **Step 2: Run complete ThinkBox verification**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Prove manual-only startup**

Use a source/wiring test and an instrumented fake Nexus service. Expected after
plugin `onload()`: zero `listWorkflows`, `getPreflight`, `start`, `getRun`, or
Claude-related call.

- [ ] **Step 4: Inspect scope and stop**

Run: `git status --short` and `git log --oneline <base>..HEAD`.

Expected: only Tasks 1–4 files and commits. Do not publish, deploy, reload,
configure the live workflow, or delete old autoarchive code.
