# Compact Workspace Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, versioned `compact` response to `memory load-workspace` that returns navigation references without loading task, state, session, prompt, activity, or file-tree payloads.

**Architecture:** Keep the current `full` response as the default and add an early-return compact path immediately after workspace resolution. A focused `WorkspaceCompactResponseBuilder` converts workspace metadata into identity plus ordered navigation references; the loader must take this path before it touches memory, prompt, task, or file-collection services. Vault consumers switch to the opt-in flag only after the plugin build is ready.

**Tech Stack:** TypeScript, Jest, JSON Schema, Nexus two-tool CLI, Obsidian plugin runtime.

**Spec:** `C:/Users/praze/ThinkBox/Producao/ThinkBox/Fundamentos/Decisoes/ADR-044-Cascata-Progressiva-no-Carregamento-de-Workspace.md`

## Global Constraints

- `detail` defaults to `full` during the compatibility phase.
- `detail: compact` must not call memory traces, session/state queries, prompt resolution, TaskService, recent-file collection, or workspace-tree collection.
- Compact output contains workspace identity, ordered navigation references, explicit omissions, `responseVersion: 2`, and `workspaceContext.workspaceId`.
- Compact output contains no task signal, task count, task list, state, session, preferences body, prompt body, workflow body, recent activity, recent files, or workspace structure.
- Full output remains behaviorally compatible and is reported as `responseVersion: 1`, `detail: full`.
- No pending-activity query is introduced. Consumers may query tasks only for an explicit resume, pending-work, next-step, or DAG request.
- No live provider/API canary and no installed-plugin replacement occurs without a separate user authorization.
- The two locale-sensitive baseline failures in `RunPythonTool.test.ts` and `DataAnalysisGuards.test.ts` are recorded as pre-existing and remain outside this change.

---

### Task 1: Compact response builder

**Files:**
- Create: `src/agents/memoryManager/services/WorkspaceCompactResponseBuilder.ts`
- Create: `tests/unit/WorkspaceCompactResponseBuilder.test.ts`
- Modify: `src/database/types/workspace/ParameterTypes.ts`

**Interfaces:**
- Consumes: `ProjectWorkspace` and its ordered `context.keyFiles` / `context.workflows` collections.
- Produces: `LoadWorkspaceCompactData`, `WorkspaceNavigationReference`, and `WorkspaceCompactResponseBuilder.build(workspace)`.

- [ ] **Step 1: Write the failing builder tests**

```typescript
import { WorkspaceCompactResponseBuilder } from '../../src/agents/memoryManager/services/WorkspaceCompactResponseBuilder';

describe('WorkspaceCompactResponseBuilder', () => {
  const workspace = {
    id: 'ws-dev',
    name: 'Desenvolvedor',
    description: 'Executor estrutural',
    rootFolder: '_Base',
    created: 1,
    lastAccessed: 2,
    context: {
      purpose: 'Governar a vault',
      keyFiles: [
        'CLAUDE.md',
        '_Base/Workflows/Desenvolvedor/WF-Roteador.md',
        '_Base/Operacional/Changelog.md'
      ],
      preferences: 'corpo que não pode vazar',
      workflows: [{
        id: 'wf-1',
        name: 'Estrutural',
        when: 'Mudança em _Base',
        steps: 'Ver [[_Base/Workflows/Default/WF-Estrutural]]'
      }]
    }
  };

  it('returns identity and ordered navigation without material bodies', () => {
    const data = new WorkspaceCompactResponseBuilder().build(workspace);

    expect(data.context).toEqual({
      name: 'Desenvolvedor',
      description: 'Executor estrutural',
      purpose: 'Governar a vault',
      rootFolder: '_Base'
    });
    expect(data.navigation.keyFiles.map(ref => ref.path)).toEqual([
      'CLAUDE.md',
      '_Base/Workflows/Desenvolvedor/WF-Roteador.md',
      '_Base/Operacional/Changelog.md'
    ]);
    expect(data.navigation.keyFiles.map(ref => ref.mustRead)).toEqual([true, true, false]);
    expect(data.navigation.workflows).toEqual([{
      id: 'wf-1',
      name: 'Estrutural',
      role: 'workflow',
      when: 'Mudança em _Base',
      path: '_Base/Workflows/Default/WF-Estrutural',
      mustRead: false
    }]);
    expect(JSON.stringify(data)).not.toContain('corpo que não pode vazar');
    expect(JSON.stringify(data)).not.toContain('Ver [[');
  });

  it('declares every omitted full-response branch explicitly', () => {
    const data = new WorkspaceCompactResponseBuilder().build(workspace);
    expect(data.omitted).toEqual([
      'recentActivity', 'workflows', 'workflowDefinitions', 'workspaceStructure',
      'recentFiles', 'keyFiles', 'preferences', 'sessions', 'states', 'prompt',
      'taskSummary'
    ]);
  });
});
```

- [ ] **Step 2: Run the builder tests and verify RED**

Run: `npx jest tests/unit/WorkspaceCompactResponseBuilder.test.ts --runInBand --no-coverage`

Expected: FAIL because `WorkspaceCompactResponseBuilder` and compact result types do not exist.

- [ ] **Step 3: Add the compact DTOs**

In `ParameterTypes.ts`, retain the current full-data interface and add:

```typescript
export type LoadWorkspaceDetail = 'compact' | 'full';

export interface WorkspaceNavigationReference {
  path: string;
  role: string;
  mustRead: boolean;
  id?: string;
  name?: string;
  when?: string;
}

export interface LoadWorkspaceCompactData {
  context: {
    name: string;
    description?: string;
    purpose?: string;
    rootFolder: string;
  };
  navigation: {
    keyFiles: WorkspaceNavigationReference[];
    workflows: WorkspaceNavigationReference[];
  };
  omitted: string[];
}
```

Add optional discriminants to the result contract without changing the default full payload:

```typescript
responseVersion?: 1 | 2;
detail?: LoadWorkspaceDetail;
```

Add `detail?: LoadWorkspaceDetail` to `LoadWorkspaceParameters`.

- [ ] **Step 4: Implement the minimal builder**

Create `WorkspaceCompactResponseBuilder.ts` with:

```typescript
const OMITTED_FULL_BRANCHES = [
  'recentActivity', 'workflows', 'workflowDefinitions', 'workspaceStructure',
  'recentFiles', 'keyFiles', 'preferences', 'sessions', 'states', 'prompt',
  'taskSummary'
] as const;

function isBootFile(path: string): boolean {
  return path === 'CLAUDE.md'
    || /(^|\/)WF-Roteador\.md$/i.test(path)
    || /(^|\/)Regras-Base-[^/]+\.md$/i.test(path);
}

function firstWikiLink(steps: string): string | undefined {
  return /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(steps)?.[1];
}
```

`build()` must preserve source ordering, use the key-file basename without `.md` as `role`, mark only boot files `mustRead: true`, and return workflow references without returning `steps`.

- [ ] **Step 5: Run the builder tests and verify GREEN**

Run: `npx jest tests/unit/WorkspaceCompactResponseBuilder.test.ts --runInBand --no-coverage`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/agents/memoryManager/services/WorkspaceCompactResponseBuilder.ts src/database/types/workspace/ParameterTypes.ts tests/unit/WorkspaceCompactResponseBuilder.test.ts
git commit -m "feat(workspace): define compact navigation response"
```

---

### Task 2: Early-return compact loader

**Files:**
- Create: `tests/unit/LoadWorkspaceCompact.test.ts`
- Modify: `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`

**Interfaces:**
- Consumes: `params.detail`, `WorkspaceCompactResponseBuilder.build(projectWorkspace)`.
- Produces: `responseVersion: 2`, `detail: compact`, compact `data`, and `workspaceContext: { workspaceId }` without expensive collaborator calls.

- [ ] **Step 1: Write the failing loader tests**

Create a real `LoadWorkspaceTool` with a resolved workspace and spies for every expensive collaborator. The central regression test is:

```typescript
it('returns compact navigation before querying tasks, memory, prompt, or files', async () => {
  const result = await tool.execute({ workspace: 'Desenvolvedor', detail: 'compact', limit: 1 });

  expect(result).toMatchObject({
    success: true,
    responseVersion: 2,
    detail: 'compact',
    workspaceContext: { workspaceId: 'ws-dev' }
  });
  expect(result.data).toHaveProperty('navigation');
  expect(result.data).not.toHaveProperty('taskSummary');
  expect(taskService.getWorkspaceSummary).not.toHaveBeenCalled();
  expect(memoryService.getMemoryTraces).not.toHaveBeenCalled();
  expect(memoryService.getSessions).not.toHaveBeenCalled();
  expect(memoryService.getStates).not.toHaveBeenCalled();
  expect(cacheManager.getRecentlyModifiedFiles).not.toHaveBeenCalled();
});
```

Add a compatibility test that omits `detail` and asserts the full path still calls `getWorkspaceSummary`, returns `taskSummary`, and reports `responseVersion: 1`, `detail: full`.

- [ ] **Step 2: Run the loader tests and verify RED**

Run: `npx jest tests/unit/LoadWorkspaceCompact.test.ts --runInBand --no-coverage`

Expected: FAIL because the loader ignores `detail` and calls the task service.

- [ ] **Step 3: Add the early return**

Immediately after workspace resolution and `updateLastAccessed`, branch before `getMemoryService()`:

```typescript
const detail = params.detail ?? 'full';
if (detail === 'compact') {
  return {
    success: true,
    responseVersion: 2,
    detail,
    data: this.compactResponseBuilder.build(projectWorkspace),
    workspaceContext: { workspaceId: projectWorkspace.id },
    ...(resolution ? { resolution } : {})
  };
}
```

Add `responseVersion: 1` and `detail: 'full'` to the existing successful full return. Keep miss recovery and error behavior unchanged.

- [ ] **Step 4: Run loader tests and verify GREEN**

Run: `npx jest tests/unit/LoadWorkspaceCompact.test.ts tests/unit/LoadWorkspaceMissRecovery.test.ts --runInBand --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/agents/memoryManager/tools/workspaces/loadWorkspace.ts tests/unit/LoadWorkspaceCompact.test.ts
git commit -m "feat(workspace): short-circuit compact loads"
```

---

### Task 3: CLI and result schemas

**Files:**
- Modify: `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`
- Modify: `tests/unit/ToolManagerCliSyntax.test.ts`
- Modify: `tests/unit/LoadWorkspaceCompact.test.ts`

**Interfaces:**
- Consumes: `detail` through the two-tool CLI normalizer.
- Produces: a discoverable `--detail compact|full` flag and schemas that describe both response modes.

- [ ] **Step 1: Write failing schema/CLI tests**

```typescript
it('parses the opt-in compact detail flag', () => {
  expect(normalizeExecutionCalls('memory load-workspace Desenvolvedor --detail compact', catalog))
    .toMatchObject([{ params: { workspace: 'Desenvolvedor', detail: 'compact' } }]);
});

it('publishes compact/full as the only detail values', () => {
  const schema = tool.getParameterSchema();
  expect(schema.properties?.detail).toMatchObject({ enum: ['compact', 'full'], default: 'full' });
});
```

Assert that `getResultSchema()` documents `responseVersion`, `detail`, `navigation`, and `omitted`.

- [ ] **Step 2: Run schema/CLI tests and verify RED**

Run: `npx jest tests/unit/ToolManagerCliSyntax.test.ts tests/unit/LoadWorkspaceCompact.test.ts --runInBand --no-coverage`

Expected: FAIL because the live schema does not declare `detail` or compact output.

- [ ] **Step 3: Extend the schemas minimally**

Add to `getParameterSchema()`:

```typescript
detail: {
  type: 'string',
  enum: ['compact', 'full'],
  default: 'full',
  description: 'compact returns navigation references only; full returns the legacy comprehensive briefing.'
}
```

Extend `getResultSchema()` with the two discriminants and compact `navigation` / `omitted` properties. Do not remove or rename existing full properties.

- [ ] **Step 4: Run schema/CLI tests and verify GREEN**

Run: `npx jest tests/unit/ToolManagerCliSyntax.test.ts tests/unit/LoadWorkspaceCompact.test.ts --runInBand --no-coverage`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/agents/memoryManager/tools/workspaces/loadWorkspace.ts tests/unit/ToolManagerCliSyntax.test.ts tests/unit/LoadWorkspaceCompact.test.ts
git commit -m "feat(workspace): expose compact load contract"
```

---

### Task 4: Documentation and ThinkBox opt-in cutover

**Files:**
- Modify: `guide/workspace-memory.md`
- Modify: `guide/nexus-cli.md`
- Modify: `C:/Users/praze/ThinkBox/_Base/Operacional/ThinkBox/REF-Nexus-Tools.md`
- Modify: `C:/Users/praze/ThinkBox/_Base/Operacional/ThinkBox/NexusConfig/prompts/PROMPT-Desenvolvedor.md`
- Modify: `C:/Users/praze/ThinkBox/_Base/Workflows/Default/WF-Estrutural.md`
- Modify: `C:/Users/praze/ThinkBox/CLAUDE.md`
- Regenerate: `C:/Users/praze/ThinkBox/AGENTS.md`
- Create or update: the applicable ThinkBox audit record required by `REF-Auditoria-Vault`.

**Interfaces:**
- Consumes: deployed support for `memory load-workspace --detail compact`.
- Produces: consumer instructions that request compact mode and never scan pending activities without an explicit trigger.

- [ ] **Step 1: Update Nexus human guidance**

Document:

```text
memory load-workspace <workspace> --detail compact
```

State that `limit` applies only to sessions, states, and recent activity in `full`; compact omits those collections and task data entirely. Explain the expansion triggers for content, workflow, state, task, and structure tools.

- [ ] **Step 2: Run shipped-guidance verification**

Run: `npx jest tests/unit/shippedGuidanceCommands.test.ts tests/unit/ToolManagerCliSyntax.test.ts --runInBand --no-coverage`

Expected: PASS.

- [ ] **Step 3: Build the plugin before touching live consumers**

Run: `npm run build`

Expected: exit 0. Do not deploy yet; installed Nexus is `5.18.2` while this source snapshot reports `5.16.2`, so release/version reconciliation is a separate gate.

- [ ] **Step 4: Apply the governed ThinkBox edits after deployment authorization**

Change the Developer bootstrap and structural workflow to request `--detail compact`. In `CLAUDE.md`, keep `retomada-cauda` continuity but remove unconditional all-workspace active-project scanning; task searches require an explicit resume/pending/next-step/DAG trigger. Regenerate `AGENTS.md` with `gerar_agents_md.py` and create the required audit record.

- [ ] **Step 5: Run ThinkBox validators**

Run:

```text
python _Base/Scripts/gerar_agents_md.py --check
python _Base/Scripts/auditar_roteamento_nexus.py scan
python _Base/Scripts/validador_artefato.py validate Producao/ThinkBox/Fundamentos/Decisoes/ADR-044-Cascata-Progressiva-no-Carregamento-de-Workspace.md
```

Expected: no new error attributable to the change. If Nexus IPC remains unavailable, record that condition and run the filesystem-backed checks without inventing a live result.

- [ ] **Step 6: Commit Nexus documentation**

```bash
git add guide/workspace-memory.md guide/nexus-cli.md
git commit -m "docs(workspace): document progressive loading"
```

---

### Task 5: Offline verification and canary handoff

**Files:**
- Verify only; no production edits unless a failing targeted test identifies a regression.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: reproducible offline evidence and a bounded live-canary proposal.

- [ ] **Step 1: Run the focused regression suite**

Run:

```text
npx jest tests/unit/WorkspaceCompactResponseBuilder.test.ts tests/unit/LoadWorkspaceCompact.test.ts tests/unit/LoadWorkspaceMissRecovery.test.ts tests/unit/TaskService.test.ts tests/unit/ToolManagerCliSyntax.test.ts tests/unit/shippedGuidanceCommands.test.ts --runInBand --no-coverage
```

Expected: all focused suites pass.

- [ ] **Step 2: Run the full test suite**

Run: `npm test -- --runInBand`

Expected: no new failure. Compare against the recorded baseline of exactly two locale-sensitive failures in `RunPythonTool.test.ts` and `DataAnalysisGuards.test.ts`; do not call the whole suite green while those remain.

- [ ] **Step 3: Run build and inspect the diff**

Run:

```text
npm run build
git diff de21302d -- src tests guide docs/superpowers/plans
```

Expected: build exit 0; diff contains only compact loading, its tests, guidance, and this plan.

- [ ] **Step 4: Prepare the live canary without running it**

Define a small scenario set for the existing `tests/eval/eval.test.ts` harness:

1. factual request that loads no task data;
2. structural request that follows `mustRead` to the router;
3. explicit resume request that expands to state/task tools;
4. control run with `detail: full`.

Stop and request authorization before setting `RUN_EVAL=1`, deploying the plugin, or changing live workspace prompts.

---

## Plan self-review

- Spec coverage: Q1A-Q8A are mapped to Tasks 1-5; default flip remains intentionally outside this first compatibility release.
- Placeholder scan: no deferred implementation placeholder remains; the only explicit stop is the user-authorized live deployment/API gate from the ADR.
- Type consistency: `detail`, `responseVersion`, `LoadWorkspaceCompactData`, and `WorkspaceNavigationReference` use the same spelling in every task.
