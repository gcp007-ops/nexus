# Nexus Supervised Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Nexus workflows with a non-blocking, read-only Claude CLI backend that persists structured plans in conversations and applies only explicitly approved operations.

**Architecture:** `WorkflowRunService` dispatches to backend implementations while conversations remain the authoritative run. A token-bound MCP proxy and server-side capability policy restrict proposal runs to read-only tools; a closed operation registry handles approved writes with precondition checks and readback.

**Tech Stack:** TypeScript, Obsidian Plugin API, Node child processes, MCP SDK, Jest, JSONL conversation storage, SQLite projections.

## Global Constraints

- Initial executor: local Claude CLI with model alias `sonnet`.
- Existing workflows without `execution` retain current chat behavior.
- Proposal runs use `capabilityProfile: vault-readonly` and cannot mutate through MCP.
- Native Claude filesystem and shell tools remain disabled; supervised runs use
  safe mode and never use `--dangerously-skip-permissions`.
- Manual and scheduled starts enqueue and return without awaiting the CLI.
- Scheduled runs never apply automatically; a later explicit human approval may
  apply their proposal. Initial `VaultHygiene-Agentico` scheduling is disabled.
- `VaultHygiene-Agentico` uses `authorityScope: vault-synced`; when scheduling
  is later enabled, only the configured `authorityDeviceId` may dispatch it.
- Cross-host exactly-once and automatic scheduler failover are out of scope.
  The supported leader is one open Nexus instance on this machine.
- `MachineHygiene` is a separate future report-only workflow; machine-local
  findings never become vault-global operations in this delivery.
- Conversation ID is the run ID; no second durable run ledger is introduced.
- Initial apply registry contains only `move`, `archive`, `setProperty`, and `replaceAnchored`.
- Approval binds exact `planHash` and selected operation IDs.
- No automatic mutation retry.
- All Obsidian DOM events use registered event handlers and all styles remain in CSS.
- No commit, push, release, deploy, reload, or live-vault configuration outside its explicit task/gate.

---

### Task 1: Workflow execution contract and normalization

**Files:**
- Modify: `src/database/types/workspace/WorkspaceTypes.ts`
- Modify: `src/services/helpers/WorkspaceNormalizer.ts`
- Modify: `src/components/workspace/WorkflowEditorRenderer.ts`
- Modify: `tests/unit/WorkflowEditorRenderer.test.ts`
- Create: `tests/unit/WorkspaceWorkflowExecution.test.ts`

**Interfaces:**
- Produces: `WorkflowExecutionConfig`, `WorkflowExecutionBackend`, `WorkflowCapabilityProfile`, and `normalizeWorkflowExecution()`.
- Consumed by: Tasks 4, 5, and 7.

- [ ] **Step 1: Add failing normalization and backwards-compatibility tests**

```ts
import { normalizeWorkspace } from '../../src/services/helpers/WorkspaceNormalizer';

it('preserves chat behavior when execution is absent', () => {
  const workspace = normalizeWorkspace(makeWorkspace({ execution: undefined }));
  expect(workspace.context?.workflows?.[0].execution).toBeUndefined();
});

it('normalizes a claude-cli proposal backend', () => {
  const workflow = firstWorkflow(normalizeWorkspace(makeWorkspace({
    execution: {
      backend: 'claude-cli', model: ' sonnet ', mode: 'proposal',
      capabilityProfile: 'vault-readonly', outputSchema: 'vault-change-plan/v1',
      maxTurns: 99, timeoutMinutes: 0, approvalRequired: true
    }
  })));
  expect(workflow.execution).toEqual({
    backend: 'claude-cli', model: 'sonnet', mode: 'proposal',
    capabilityProfile: 'vault-readonly', outputSchema: 'vault-change-plan/v1',
    maxTurns: 40, timeoutMinutes: 1, approvalRequired: true
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- --runInBand tests/unit/WorkspaceWorkflowExecution.test.ts`

Expected: FAIL because `execution` types and normalization do not exist.

- [ ] **Step 3: Add the typed contract and normalizer**

```ts
export type WorkflowExecutionBackend = 'chat' | 'claude-cli';
export type WorkflowCapabilityProfile = 'vault-readonly';

export interface WorkflowExecutionConfig {
  backend: WorkflowExecutionBackend;
  model?: string;
  mode: 'proposal';
  capabilityProfile: WorkflowCapabilityProfile;
  outputSchema: 'vault-change-plan/v1';
  maxTurns: number;
  timeoutMinutes: number;
  approvalRequired: true;
}

export interface WorkspaceWorkflow {
  id: string;
  name: string;
  when: string;
  steps: string;
  promptId?: string;
  promptName?: string;
  execution?: WorkflowExecutionConfig;
  schedule?: WorkflowSchedule;
}
```

Normalize `maxTurns` to `1..40`, `timeoutMinutes` to `1..60`, trim `model`, and
drop invalid execution blocks rather than converting legacy workflows.

- [ ] **Step 4: Add failing workflow-editor tests for the fifth section**

```ts
it('renders Execution between Steps and Schedule', () => {
  renderEditor(makeWorkflow({ execution: claudeExecution() }));
  expect(recordedSections.map(section => section.config.title)).toEqual([
    'Identity', 'Prompt', 'Steps', 'Execution', 'Schedule'
  ]);
});

it('does not enable a write-capable profile', () => {
  const saved = saveRenderedWorkflow({ backend: 'claude-cli' });
  expect(saved.execution?.capabilityProfile).toBe('vault-readonly');
  expect(saved.execution?.approvalRequired).toBe(true);
});
```

- [ ] **Step 5: Render and persist the execution fields**

Add one `BoxedSection` with backend, model, max turns, timeout, capability
profile, output schema, and approval copy. Do not add a bypass-permissions
control. Preserve `execution` in `cloneWorkflow()` and
`validateAndBuildWorkflow()`.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- --runInBand tests/unit/WorkspaceWorkflowExecution.test.ts tests/unit/WorkflowEditorRenderer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/database/types/workspace/WorkspaceTypes.ts src/services/helpers/WorkspaceNormalizer.ts src/components/workspace/WorkflowEditorRenderer.ts tests/unit/WorkspaceWorkflowExecution.test.ts tests/unit/WorkflowEditorRenderer.test.ts
git commit -m "feat: define supervised workflow execution"
```

---

### Task 2: Token-bound read-only MCP capability policy

**Files:**
- Create: `src/services/workflows/AgentCapabilityPolicyService.ts`
- Create: `src/services/workflows/AgentRunProxySource.ts`
- Modify: `src/connector.ts`
- Modify: `src/agents/toolManager/types.ts`
- Modify: `src/agents/toolManager/tools/getTools.ts`
- Modify: `src/agents/toolManager/services/ToolBatchExecutionService.ts`
- Modify: `src/core/services/ServiceDefinitions.ts`
- Create: `tests/unit/AgentCapabilityPolicyService.test.ts`
- Create: `tests/unit/AgentRunProxySource.test.ts`
- Modify: `tests/unit/ToolManagerContextContract.test.ts`

**Interfaces:**
- Produces: `AgentCapabilityPolicyService.issue(runId, profile)`, `.resolve(token)`, `.revoke(token)`, `.allows(grant, agent, tool)`, and `buildAgentRunProxySource()`.
- Consumed by: Task 3 Claude backend.

- [ ] **Step 1: Write failing policy tests using an explicit allowlist**

```ts
const policy = new AgentCapabilityPolicyService(() => 'token-1');
const issued = policy.issue('run-1', 'vault-readonly');

expect(policy.resolve(issued.token)).toMatchObject({ runId: 'run-1', profile: 'vault-readonly' });
expect(policy.allows(issued.grant, 'contentManager', 'read')).toBe(true);
expect(policy.allows(issued.grant, 'searchManager', 'content')).toBe(true);
expect(policy.allows(issued.grant, 'memoryManager', 'loadWorkspace')).toBe(true);
expect(policy.allows(issued.grant, 'contentManager', 'write')).toBe(false);
expect(policy.allows(issued.grant, 'storageManager', 'move')).toBe(false);
expect(policy.allows(issued.grant, 'taskManager', 'update')).toBe(false);
```

The allowlist must be literal and reviewed. Include only discovery/read/list/get,
search, workspace/state load/list, task/project list/query/open, and canvas read/list.

- [ ] **Step 2: Run the policy test and confirm RED**

Run: `npm test -- --runInBand tests/unit/AgentCapabilityPolicyService.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement issuance, constant-time lookup, expiry, and revocation**

```ts
export interface AgentCapabilityGrant {
  runId: string;
  profile: 'vault-readonly';
  expiresAt: number;
}

issue(runId: string, profile: 'vault-readonly', ttlMs = 60 * 60_000): {
  token: string;
  grant: AgentCapabilityGrant;
};
```

Tokens are random, expire, and remain in memory except for the controlled
mode-`0600` MCP configuration created by Task 3. They are never logged, stored
in conversation metadata, synced storage, or vault files.

- [ ] **Step 4: Write failing dispatcher tests for discovery and forged writes**

```ts
it('filters getTools and blocks a forged useTools mutation', async () => {
  const grant = issueGrant('vault-readonly');
  const discovered = await getTools.execute(withInternalGrant(grant, { tool: '--help' }));
  expect(commands(discovered)).toContain('content read');
  expect(commands(discovered)).not.toContain('content write');

  const result = await useTools.execute(withInternalGrant(grant, {
    tool: 'content write --path x.md --content blocked'
  }));
  expect(result).toMatchObject({ success: false });
  expect(result.error).toContain('capability profile vault-readonly');
});
```

- [ ] **Step 5: Enforce grants inside discovery and per normalized call**

Add an internal-only `_agentCapabilityGrant` field that is not present in public
schemas. `connector.ts` must discard caller-provided grant data, resolve the
proxy-injected token through `AgentCapabilityPolicyService`, and attach the
trusted grant. `GetToolsTool` filters schemas; `ToolBatchExecutionService`
checks every normalized call immediately before execution.

- [ ] **Step 6: Write failing proxy tests**

```ts
it('injects the token into tools/call params without exposing it in stdout', () => {
  const source = buildAgentRunProxySource();
  const forwarded = exerciseProxy(source, rpcToolCall(), { NEXUS_AGENT_RUN_TOKEN: 'secret' });
  expect(forwarded.params.arguments._agentCapabilityToken).toBe('secret');
  expect(forwarded.stdout).not.toContain('secret');
});
```

- [ ] **Step 7: Implement the temporary proxy source**

The generated Node program connects to the configured Nexus socket, parses
newline-delimited JSON-RPC from stdin, injects `_agentCapabilityToken` only into
`tools/call` arguments, forwards responses unchanged, and never prints the
token. Invalid JSON terminates with a non-zero exit rather than bypassing the
filter.

- [ ] **Step 8: Run Task 2 tests**

Run: `npm test -- --runInBand tests/unit/AgentCapabilityPolicyService.test.ts tests/unit/AgentRunProxySource.test.ts tests/unit/ToolManagerContextContract.test.ts tests/unit/ToolManagerCliSyntax.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/services/workflows/AgentCapabilityPolicyService.ts src/services/workflows/AgentRunProxySource.ts src/connector.ts src/agents/toolManager/types.ts src/agents/toolManager/tools/getTools.ts src/agents/toolManager/services/ToolBatchExecutionService.ts src/core/services/ServiceDefinitions.ts tests/unit/AgentCapabilityPolicyService.test.ts tests/unit/AgentRunProxySource.test.ts tests/unit/ToolManagerContextContract.test.ts
git commit -m "feat: enforce read-only agent capabilities"
```

---

### Task 3: Cancellable Claude CLI backend

**Files:**
- Create: `src/services/workflows/WorkflowExecutionBackend.ts`
- Create: `src/services/workflows/ClaudeCliWorkflowBackend.ts`
- Modify: `src/services/external/ClaudeHeadlessService.ts`
- Modify: `tests/unit/ClaudeHeadlessService.test.ts`
- Create: `tests/unit/ClaudeCliWorkflowBackend.test.ts`

**Interfaces:**
- Consumes: Task 2 capability issuance and proxy source.
- Produces: `WorkflowExecutionBackend.start(request): WorkflowExecutionHandle` and a Claude implementation with `result` plus `cancel()`.
- Consumed by: Task 5 run service.

- [ ] **Step 1: Write failing process-lifecycle tests**

```ts
it('returns immediately with a cancellable handle', async () => {
  const handle = backend.start(makeRequest());
  expect(handle.runId).toBe('run-1');
  expect(typeof handle.cancel).toBe('function');
  await handle.cancel();
  await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' });
  expect(fakeProcess.killTree).toHaveBeenCalledTimes(1);
});

it('kills the process tree on timeout and preserves partial output', async () => {
  const result = await backend.start(makeRequest({ timeoutMs: 10 })).result;
  expect(result).toMatchObject({ status: 'timed_out', stdout: 'partial' });
  expect(fakeProcess.killTree).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the backend test and confirm RED**

Run: `npm test -- --runInBand tests/unit/ClaudeCliWorkflowBackend.test.ts`

Expected: FAIL because the backend interface does not exist.

- [ ] **Step 3: Define exact backend types**

```ts
export interface WorkflowExecutionRequest {
  runId: string;
  prompt: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  capabilityProfile: 'vault-readonly';
}

export interface WorkflowExecutionHandle {
  runId: string;
  result: Promise<WorkflowExecutionResult>;
  cancel(): Promise<void>;
}
```

- [ ] **Step 4: Refactor headless execution around a retained child handle**

Replace the promise-only private `runProcess()` path with a small process runner
that captures stdout/stderr, exposes `terminateTree()`, settles once, removes
listeners, and cleans the temp directory after completion. Keep prompt transport
on stdin. The MCP config must invoke the temporary token-injecting proxy, not the
unfiltered installed connector. Put `NEXUS_AGENT_RUN_TOKEN` only in that MCP
server's `env` block; never put it in the Claude process environment. Create the
config in a unique local directory with mode `0600`, and make a final cleanup
failure terminal `failed`.

- [ ] **Step 5: Make bypass non-configurable for workflow runs**

`ClaudeCliWorkflowBackend` constructs fixed CLI arguments. `serverKey` is the
exact value returned by `getPrimaryServerKey()` and used by the temporary MCP
configuration:

```ts
[
  '-p', '--strict-mcp-config', '--mcp-config', mcpConfigPath,
  '--safe-mode', '--tools', '',
  '--allowedTools',
  `mcp__${serverKey}__toolManager_getTools,mcp__${serverKey}__toolManager_useTools`,
  '--disable-slash-commands', '--output-format', 'text',
  '--max-turns', String(request.maxTurns), '--model', 'sonnet'
]
```

The backend accepts only the initial approved model alias `sonnet`. It executes
native binaries with structured argv and `shell: false`; on Windows, resolution
must prefer a native executable and fail closed when only `.cmd`/`.bat` wrappers
exist.

- [ ] **Step 6: Cover late close/error, double cancel, and temp cleanup**

Add tests proving only the first terminal event wins, double cancel is
idempotent, the capability token is revoked, and the temporary proxy/config
directory is removed on every terminal path. Also cover token absence from the
Claude environment, proxy-only token injection, mode `0600`, Windows native
binary preference, forced escalation after a failed graceful `taskkill`, POSIX
root-close-before-grace, and cleanup failure.

- [ ] **Step 7: Run Task 3 tests**

Run: `npm test -- --runInBand tests/unit/ClaudeHeadlessService.test.ts tests/unit/ClaudeCliWorkflowBackend.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/services/workflows/WorkflowExecutionBackend.ts src/services/workflows/ClaudeCliWorkflowBackend.ts src/services/external/ClaudeHeadlessService.ts tests/unit/ClaudeHeadlessService.test.ts tests/unit/ClaudeCliWorkflowBackend.test.ts
git commit -m "feat: add cancellable Claude workflow backend"
```

---

### Task 4: Versioned vault-change plan contract

**Files:**
- Create: `src/services/workflows/VaultChangePlan.ts`
- Create: `tests/unit/VaultChangePlan.test.ts`

**Interfaces:**
- Produces: `parseVaultChangePlan(raw, expected)`, `canonicalPlanJson(plan)`, `hashVaultChangePlan(plan)`, and operation union types.
- Consumed by: Tasks 5, 6, and the ThinkBox plan.

- [ ] **Step 1: Write failing contract tests**

```ts
it('accepts only the four closed operation types', () => {
  const parsed = parseVaultChangePlan(validPlan(), expectedIdentity());
  expect(parsed.operations.map(item => item.type)).toEqual([
    'move', 'archive', 'setProperty', 'replaceAnchored'
  ]);
});

it.each(['contentWrite', 'taskUpdate', 'shell'])('rejects %s', type => {
  expect(() => parseVaultChangePlan(planWithOperation(type), expectedIdentity()))
    .toThrow('unsupported operation type');
});

it('produces the same hash for different object key order', () => {
  expect(hashVaultChangePlan(validPlan())).toBe(hashVaultChangePlan(reorderedPlan()));
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- --runInBand tests/unit/VaultChangePlan.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement strict parsing and limits**

Define discriminated operation interfaces with shared fields
`operationId`, `findingId`, `evidence`, `preconditions`, `expectedEffect`,
`risk`, `dependsOn`, and `rollback`. Reject duplicate IDs, missing dependencies,
cycles, absolute/out-of-vault paths, unknown keys at security-sensitive levels,
more than 100 operations, and raw output over 1 MiB.

- [ ] **Step 4: Bind run/workflow/prompt/workspace identity**

```ts
export interface ExpectedPlanIdentity {
  runId: string;
  workflowId: string;
  promptHash: string;
  workflowHash: string;
  workspaceId: string;
}
```

Reject any mismatch before hashing.

- [ ] **Step 5: Run contract tests**

Run: `npm test -- --runInBand tests/unit/VaultChangePlan.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/services/workflows/VaultChangePlan.ts tests/unit/VaultChangePlan.test.ts
git commit -m "feat: validate vault change plans"
```

---

### Task 5: Conversation-backed run lifecycle and non-blocking scheduling

**Files:**
- Modify: `src/services/workflows/AgentRunService.ts`
- Modify: `src/services/workflows/WorkflowRunService.ts`
- Modify: `src/services/workflows/WorkflowScheduleService.ts`
- Create: `src/services/workflows/WorkflowAuthorityService.ts`
- Create: `src/services/workflows/WorkflowRunReservationService.ts`
- Modify: `src/services/workflows/WorkflowExecutionBackend.ts`
- Modify: `src/services/workflows/ClaudeCliWorkflowBackend.ts`
- Modify: `src/services/workflows/AgentCapabilityPolicyService.ts`
- Modify: `src/services/workflows/types.ts`
- Modify: `src/database/types/workspace/WorkspaceTypes.ts`
- Modify: `src/services/helpers/WorkspaceNormalizer.ts`
- Modify: `src/database/storage/JSONLWriter.ts`
- Modify: `src/database/repositories/interfaces/IConversationRepository.ts`
- Modify: `src/database/repositories/ConversationRepository.ts`
- Modify: `src/database/interfaces/IStorageAdapter.ts`
- Modify: `src/database/adapters/HybridStorageAdapter.ts`
- Modify: `src/services/ConversationService.ts`
- Modify: `src/services/chat/ChatService.ts`
- Modify: `src/services/chat/ConversationManager.ts`
- Modify: `src/types/storage/HybridStorageTypes.ts`
- Modify: `src/core/services/ServiceDefinitions.ts`
- Modify: `src/core/background/BackgroundProcessor.ts`
- Modify: `src/components/workspace/WorkflowEditorRenderer.ts`
- Modify: `src/settings/tabs/WorkspacesTab.ts`
- Modify: `tests/unit/AgentRunService.test.ts`
- Modify: `tests/unit/WorkflowRunService.test.ts`
- Modify: `tests/unit/WorkflowScheduleService.test.ts`
- Create: `tests/unit/WorkflowAuthorityService.test.ts`
- Modify: `tests/unit/AgentCapabilityPolicyService.test.ts`
- Modify: `tests/unit/ClaudeCliWorkflowBackend.test.ts`
- Modify: `tests/unit/ConversationRepository.test.ts`
- Modify: `tests/unit/WorkspaceWorkflowExecution.test.ts`
- Modify: `tests/unit/WorkflowEditorRenderer.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, and 4.
- Produces: authority-gated `WorkflowRunService.start`, local `runKey`
  reservation, CAS-backed `AgentRunService` transitions, structured security
  outcomes, and stable restart reconciliation.
- Consumed by: Tasks 6 and 7 and the ThinkBox plan.

The Task 5 correction also closes the scheduling authority boundary:

```ts
type WorkflowAuthorityScope = 'vault-synced' | 'machine-local';

interface WorkflowExecutionConfig {
  backend: 'chat' | 'claude-cli';
  authorityScope: WorkflowAuthorityScope;
  authorityDeviceId?: string;
  model?: string;
  mode: 'proposal';
  capabilityProfile: 'vault-readonly';
  outputSchema: 'vault-change-plan/v1';
  maxTurns: number;
  timeoutMinutes: number;
  approvalRequired: true;
}
```

Normalize existing supervised executions to `vault-synced`. A scheduled
`vault-synced` workflow requires a non-empty `authorityDeviceId`; manual and
scheduled starts compare it with the existing local `claudesidian-device-id`
before conversation creation or reservation. A future
`machine-local` run key is namespaced by device ID and remains report-only.
The existing Execution editor persists the scope and authority ID, offers the
current device ID as an explicit user action, and does not expose
`machine-local` execution until its local-read capability exists.

- [ ] **Step 1: Write failing authority and reservation tests**

```ts
it('accepts only the configured vault authority device', () => {
  const authority = new WorkflowAuthorityService(appWithDeviceId('device-a'));
  expect(authority.assertCanRun(makeExecution({ authorityDeviceId: 'device-a' })))
    .toBe('device-a');
  expect(() => authority.assertCanRun(makeExecution({ authorityDeviceId: 'device-b' })))
    .toThrow('Workflow authority device mismatch');
});

it('rejects a vault-synced run on a non-authority device before persistence', async () => {
  authority.assertCanRun.mockImplementation(() => {
    throw new Error('Workflow authority device mismatch');
  });
  await expect(service.start(makeRequest({ authorityDeviceId: 'device-a' })))
    .rejects.toThrow('Workflow authority device mismatch');
  expect(chatService.createConversation).not.toHaveBeenCalled();
});

it('reserves one runKey across concurrent services in this Nexus instance', async () => {
  const reservation = new WorkflowRunReservationService();
  const first = makeWorkflowRunService({ reservation, createGate });
  const second = makeWorkflowRunService({ reservation, createGate });
  const a = first.start(makeRequest({ runKey: 'slot-1' }));
  await createGate.entered;
  await expect(second.start(makeRequest({ runKey: 'slot-1' })))
    .rejects.toThrow('Workflow run is already reserved: slot-1');
  createGate.release();
  await a;
});
```

- [ ] **Step 2: Run authority tests and confirm RED**

Run: `npm test -- --runInBand tests/unit/WorkflowRunService.test.ts tests/unit/WorkflowScheduleService.test.ts tests/unit/WorkflowEditorRenderer.test.ts`

Expected: FAIL because authority fields, the authority service and the shared
reservation do not exist.

- [ ] **Step 3: Implement the authority boundary and local reservation**

```ts
export class WorkflowAuthorityService {
  constructor(private readonly app: Pick<App, 'loadLocalStorage'>) {}
  currentDeviceId(): string;
  assertCanRun(execution: WorkflowExecutionConfig): string;
}

export class WorkflowRunReservationService {
  runExclusive<T>(runKey: string, action: () => Promise<T>): Promise<T>;
}
```

Export one `NEXUS_DEVICE_ID_STORAGE_KEY` constant from `JSONLWriter.ts` and use
it both there and in `WorkflowAuthorityService`; do not create a second device
identity. `assertCanRun` accepts only `vault-synced`, requires a non-empty
`authorityDeviceId`, compares it with the current ID and returns that ID.
`WorkflowRunService.start()` calls it before `hasRunKey`, reservation,
conversation creation or backend dispatch. Inside `runExclusive`, recheck
`ConversationService.hasRunKey(runKey)` and create the conversation before
releasing the key. Inject one reservation instance from `ServiceDefinitions` so
manual and scheduled callers share it.

- [ ] **Step 4: Persist and render authority configuration**

Normalize existing `claude-cli` blocks to `authorityScope: 'vault-synced'` but
leave `authorityDeviceId` absent so they fail closed until explicitly assigned.
Add fixed `Vault synced` scope copy and an authority-device text field to the
Execution editor. Pass the current device ID from `WorkspacesTab`; a button
labelled `Use this device` copies it into the draft. Validate a non-empty ID on
save. Do not offer `machine-local` in this delivery.

- [ ] **Step 5: Write failing CAS, early-cancel and orphan-handle tests**

```ts
it('cancels a start requested before queued metadata exists', async () => {
  const start = service.start(makeStartRequest());
  const cancel = service.cancel('conversation-1');
  releaseConversationRead();
  await expect(cancel).resolves.toMatchObject({ status: 'cancelled' });
  expect(backend.start).not.toHaveBeenCalled();
  await start;
});

it('terminates the retained handle before surfacing running persistence failure', async () => {
  conversations.mutateConversationMetadata.mockRejectedValueOnce(new Error('disk'));
  await expect(service.start(makeStartRequest())).rejects.toThrow('disk');
  expect(handle.cancel).toHaveBeenCalledTimes(1);
  await expect(handle.result).resolves.toBeDefined();
});

it('does not overwrite a concurrently completed run during reconciliation', async () => {
  conversations.mutateConversationMetadata.mockResolvedValue({ applied: false });
  await service.reconcileInterrupted();
  const mutate = conversations.mutateConversationMetadata.mock.calls[0][1];
  expect(mutate({ agentRun: makeRun({ status: 'completed' }) })).toBeNull();
});
```

- [ ] **Step 6: Run lifecycle-race tests and confirm RED**

Run: `npm test -- --runInBand tests/unit/AgentRunService.test.ts`

Expected: FAIL on cancellation before first persistence, rejected running
persistence leaving a detached handle, and non-CAS reconciliation.

- [ ] **Step 7: Add serialized compare-and-set metadata mutation**

```ts
export interface ConversationMetadataMutationResult {
  applied: boolean;
  metadata?: NonNullable<ConversationData['metadata']>;
}

mutateConversationMetadata(
  conversationId: string,
  mutate: (
    current: Readonly<NonNullable<ConversationData['metadata']>>
  ) => NonNullable<ConversationData['metadata']> | null
): Promise<ConversationMetadataMutationResult>;
```

Implement this method in `ConversationManager` with one `NamedLocks` lock per
conversation. Inside the lock, reread the authoritative conversation, call the
pure mutator on the latest metadata, treat `null` as a failed comparison and
write the returned whole metadata once. Expose it through `ChatService`.
`AgentRunService` must use a `persistTransition(runId, expectedStatuses, next)`
helper where `expectedStatuses` is
`readonly (AgentRunStatus | undefined)[]`. Its mutator checks the latest typed
`agentRun.status`, replaces only `agentRun`, and preserves every sibling key.
A failed comparison is a benign no-op for completion/restart races and an error
for the initiating queued-to-running transition.

Replace the pre-persistence cancellation promise with a start entry containing
`cancelRequested` plus a deferred settled result. After queued metadata is
written, a requested cancellation persists `cancelled` and never calls
`backend.start`. If the backend has started and the running CAS/write fails,
await `handle.cancel()` and `handle.result` before removing it or propagating
the storage error; make a best-effort CAS to `failed` without weakening the
requirement that the process is already terminated.

- [ ] **Step 8: Write failing stable-snapshot reconciliation tests**

```ts
it('snapshots IDs before transitions can reorder conversations', async () => {
  conversationService.getConversationIdsSnapshot.mockResolvedValue(['a', 'b', 'c']);
  await service.reconcileInterrupted();
  expect(conversationService.getConversationIdsSnapshot).toHaveBeenCalledTimes(1);
  expect(conversationService.getConversation).toHaveBeenCalledWith('a');
  expect(conversationService.getConversation).toHaveBeenCalledWith('b');
  expect(conversationService.getConversation).toHaveBeenCalledWith('c');
});
```

- [ ] **Step 9: Implement an immutable ID snapshot for restart reconciliation**

Add `getConversationIdsSnapshot(): Promise<string[]>` to the repository,
adapter and conversation service contracts. The hybrid repository executes
`SELECT id FROM conversations ORDER BY id ASC` and returns only IDs; the legacy
fallback sorts `Object.keys(index.conversations)`. `ConversationManager` first
obtains this complete immutable array, then hydrates those IDs. It must not use
`LIMIT/OFFSET` ordered by mutable `updated`. `reconcileInterrupted()` then CASes
only snapshot members still in `queued` or `running` to `interrupted`.

- [ ] **Step 10: Write failing structured-security and truncation tests**

```ts
it('returns a structured securityBlocked result after a denied valid grant', async () => {
  policy.allows(issued.grant, 'contentManager', 'write');
  expect(policy.revoke(issued.token)).toBe(true);
});

it.each([
  { stdoutTruncated: true, stderrTruncated: false },
  { stdoutTruncated: false, stderrTruncated: true }
])('rejects truncated completed output', async flags => {
  backend.resolve({ ...completed(validPlanText()), ...flags });
  await completion;
  expect(await service.get('conversation-1')).toMatchObject({ status: 'invalid_output' });
});
```

- [ ] **Step 11: Propagate policy denial structurally**

Add `securityBlocked: boolean` to `WorkflowExecutionResult`. Track denial on the
issued token inside `AgentCapabilityPolicyService`: `allows()` marks a valid
grant when it rejects an agent/tool pair, and `revoke(token)` returns and clears
that token's denial bit. `ClaudeCliWorkflowBackend` captures this boolean during
its mandatory revoke cleanup and returns it after token redaction. Remove the
`CAPABILITY_REJECTION` regex from `AgentRunService`; transition to
`security_blocked` only from the structured boolean. A `completed` result with
either truncation flag is `invalid_output` before parsing, even when the visible
stdout is valid JSON.

- [ ] **Step 12: Write failing hash-only conversation tests**

```ts
it('does not persist the resolved Claude prompt in chat settings', async () => {
  await service.start(makeClaudeRequest());
  expect(chatService.createConversation).toHaveBeenCalledWith(
    expect.any(String),
    undefined,
    expect.not.objectContaining({ systemPrompt: expect.any(String) })
  );
  expect(agentRunService.start).toHaveBeenCalledWith(
    expect.objectContaining({ resolvedPrompt: 'resolved secret-free prompt' })
  );
});
```

- [ ] **Step 13: Keep the resolved prompt in memory only**

Hash canonical snapshots and persist only hashes plus the non-secret resolved
configuration. For `claude-cli`, omit `systemPrompt` and all resolved
workspace/saved-prompt text from `createConversation` chat settings. Pass it
only in the in-memory `AgentRunStartRequest`, hash it in `AgentRunService`, and
construct the exact backend prompt from the `CLAUDE.md` instruction, workspace,
saved prompt, workflow steps, output schema and explicit no-write contract.
Do not persist the capability token outside Task 3's controlled mode-`0600`
temporary MCP config. Keep the legacy chat path behavior unchanged.

- [ ] **Step 14: Dispatch chat and Claude backends without changing legacy runs**

`WorkflowRunService.start()` keeps the current chat path when `execution` is
absent or `backend === 'chat'`. For `claude-cli`, it creates the hash-only
conversation, queues through `AgentRunService`, and returns before
`handle.result` settles.

- [ ] **Step 15: Write failing scheduler non-blocking tests**

```ts
it('enqueues due workflows without awaiting completion', async () => {
  workflowRunService.start.mockReturnValue(new Promise(() => undefined));
  const start = service.start();
  await expect(start).resolves.toBeUndefined();
});

it('never advances a scheduled proposal to applying', async () => {
  await service.dispatchDueRun('run-1');
  expect(agentRunService.approveAndApply).not.toHaveBeenCalled();
  expect(await agentRunService.getRun('run-1')).toMatchObject({
    trigger: 'schedule', status: 'awaiting_approval'
  });
});

it('dispatches a synchronized schedule only on its configured leader', async () => {
  await nonLeader.dispatchDueRun('run-1');
  expect(workflowRunService.start).not.toHaveBeenCalled();
  await leader.dispatchDueRun('run-1');
  expect(workflowRunService.start).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 16: Separate schedule calculation from queued dispatch**

`WorkflowScheduleService.start()` registers its interval and schedules the
initial scan in a detached microtask. Each due slot awaits only conversation/job
creation, not CLI completion. Before calculating due slots for a `claude-cli`
workflow, the scheduler calls the same `WorkflowAuthorityService.assertCanRun`;
a non-authority device neither calculates nor dispatches that workflow. Preserve
proposal-only behavior. The shared
`WorkflowRunService` reservation performs the runKey check-and-create boundary;
the scheduler does not implement a second lock. Do not claim cross-host
exclusion: `authorityDeviceId` plus the one-open-instance operating constraint
is the boundary. Record `authorityScope` and the actual local `deviceId` in
`metadata.agentRun` and include them in the workflow hash.

- [ ] **Step 17: Run Task 5 tests**

Run: `npm test -- --runInBand tests/unit/AgentRunService.test.ts tests/unit/WorkflowRunService.test.ts tests/unit/WorkflowScheduleService.test.ts tests/unit/WorkflowAuthorityService.test.ts tests/unit/AgentCapabilityPolicyService.test.ts tests/unit/ClaudeCliWorkflowBackend.test.ts tests/unit/ConversationRepository.test.ts tests/unit/WorkspaceWorkflowExecution.test.ts tests/unit/WorkflowEditorRenderer.test.ts`

Expected: PASS.

- [ ] **Step 18: Run proportional regression gates**

Run: `npx tsc --noEmit --skipLibCheck`

Run: `npx eslint src/services/workflows/AgentRunService.ts src/services/workflows/WorkflowRunService.ts src/services/workflows/WorkflowScheduleService.ts src/services/workflows/WorkflowAuthorityService.ts src/services/workflows/WorkflowRunReservationService.ts src/services/workflows/WorkflowExecutionBackend.ts src/services/workflows/ClaudeCliWorkflowBackend.ts src/services/workflows/AgentCapabilityPolicyService.ts src/services/chat/ConversationManager.ts src/services/chat/ChatService.ts src/services/ConversationService.ts src/database/repositories/ConversationRepository.ts src/database/storage/JSONLWriter.ts src/components/workspace/WorkflowEditorRenderer.ts`

Run: `npm run build`

Run: `git diff --check`

Expected: every command exits 0. Preserve the recorded unrelated
`TaskBoardEditCoordinator.test.ts` baseline failure; it is not evidence for or
against this task.

- [ ] **Step 19: Commit the Task 5 correction**

```bash
git add src/services/workflows/AgentRunService.ts src/services/workflows/WorkflowRunService.ts src/services/workflows/WorkflowScheduleService.ts src/services/workflows/WorkflowAuthorityService.ts src/services/workflows/WorkflowRunReservationService.ts src/services/workflows/WorkflowExecutionBackend.ts src/services/workflows/ClaudeCliWorkflowBackend.ts src/services/workflows/AgentCapabilityPolicyService.ts src/services/workflows/types.ts src/database/types/workspace/WorkspaceTypes.ts src/services/helpers/WorkspaceNormalizer.ts src/database/storage/JSONLWriter.ts src/database/repositories/interfaces/IConversationRepository.ts src/database/repositories/ConversationRepository.ts src/database/interfaces/IStorageAdapter.ts src/database/adapters/HybridStorageAdapter.ts src/services/ConversationService.ts src/services/chat/ChatService.ts src/services/chat/ConversationManager.ts src/types/storage/HybridStorageTypes.ts src/core/services/ServiceDefinitions.ts src/core/background/BackgroundProcessor.ts src/components/workspace/WorkflowEditorRenderer.ts src/settings/tabs/WorkspacesTab.ts tests/unit/AgentRunService.test.ts tests/unit/WorkflowRunService.test.ts tests/unit/WorkflowScheduleService.test.ts tests/unit/WorkflowAuthorityService.test.ts tests/unit/AgentCapabilityPolicyService.test.ts tests/unit/ClaudeCliWorkflowBackend.test.ts tests/unit/ConversationRepository.test.ts tests/unit/WorkspaceWorkflowExecution.test.ts tests/unit/WorkflowEditorRenderer.test.ts
git commit -m "fix: enforce supervised run authority"
```

---

### Task 6: Approval and deterministic vault applier

**Files:**
- Create: `src/services/workflows/VaultChangeApplier.ts`
- Create: `src/services/workflows/VaultChangePreconditions.ts`
- Modify: `src/services/workflows/AgentRunService.ts`
- Modify: `src/core/services/ServiceDefinitions.ts`
- Create: `tests/unit/VaultChangeApplier.test.ts`
- Modify: `tests/unit/AgentRunService.test.ts`

**Interfaces:**
- Consumes: Task 4 plans and Task 5 runs.
- Produces: `AgentRunService.approveAndApply(request)` and per-operation results.
- Consumed by: Task 8 and ThinkBox.

```ts
export interface ApprovalRequest {
  runId: string;
  planHash: string;
  operationIds: string[];
  approval: {
    kind: 'human';
    source: 'nexus-ui' | 'thinkbox';
    confirmedAt: number;
  };
}

export type VaultOperationStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked_dependency'
  | 'readback_failed'
  | 'rolled_back'
  | 'rollback_failed';

export interface VaultOperationResult {
  operationId: string;
  type: VaultChangeOperation['type'];
  status: VaultOperationStatus;
  startedAt: number;
  finishedAt: number;
  readback?: Record<string, unknown>;
  error?: string;
  rollbackError?: string;
}

export interface VaultChangeApplyResult {
  runId: string;
  planHash: string;
  status: 'completed' | 'completed_with_issues';
  operations: VaultOperationResult[];
}
```

- [ ] **Step 1: Write failing approval-binding tests**

```ts
await expect(service.approveAndApply({
  runId: 'run-1', planHash: 'sha256:wrong', operationIds: ['op-1'],
  approval: { kind: 'human', source: 'nexus-ui', confirmedAt: NOW }
})).rejects.toThrow('plan hash');

const missingApproval = {
  runId: 'run-1', planHash: validHash, operationIds: ['op-1']
} as unknown as ApprovalRequest;
await expect(service.approveAndApply(missingApproval))
  .rejects.toThrow('explicit human approval context');
```

- [ ] **Step 2: Write failing operation tests**

```ts
it.each(['move', 'archive', 'setProperty', 'replaceAnchored'] as const)(
  'applies and reads back a selected %s operation', async type => {
    const result = await applier.apply(makePlan(type), approvalFor('op-1'));
    expect(result.operations).toEqual([
      expect.objectContaining({ operationId: 'op-1', type, status: 'succeeded' })
    ]);
  }
);

it('continues an independent operation and blocks a dependent after failure', async () => {
  executor.fail('op-1');
  const result = await applier.apply(planWithDependencies(), approvalFor('op-1', 'op-2', 'op-3'));
  expect(statuses(result)).toEqual({
    'op-1': 'failed', 'op-2': 'blocked_dependency', 'op-3': 'succeeded'
  });
});

it('rolls back an applied effect when authoritative readback fails', async () => {
  executor.failReadback('op-1');
  const result = await applier.apply(makePlan('replaceAnchored'), approvalFor('op-1'));
  expect(result.operations[0].status).toBe('rolled_back');
  expect(executor.rollback).toHaveBeenCalledTimes(1);
});

it('reports rollback_failed without retrying the effect', async () => {
  executor.failReadback('op-1');
  executor.failRollback('op-1');
  const result = await applier.apply(makePlan('setProperty'), approvalFor('op-1'));
  expect(result.operations[0].status).toBe('rollback_failed');
  expect(executor.apply).toHaveBeenCalledTimes(1);
});
```

```ts
await expect(applier.apply(plan, approvalFor('op-1', 'op-1')))
  .rejects.toThrow('duplicate selected operationId');
await expect(applier.apply(planDependingOnOp0(), approvalFor('op-1')))
  .rejects.toThrow('selected operation op-1 requires selected dependency op-0');
expect(events.appendApproval).not.toHaveBeenCalled();
expect(executor.apply).not.toHaveBeenCalled();

preconditions.setCurrentHash('note.md', 'sha256:stale');
await expect(applier.apply(planExpectingFreshHash(), approvalFor('op-1')))
  .resolves.toMatchObject({ operations: [expect.objectContaining({ status: 'failed' })] });
expect(executor.apply).not.toHaveBeenCalled();

await applier.apply(plan, approvalFor('op-1'));
expect(events.appendApproval.mock.invocationCallOrder[0])
  .toBeLessThan(executor.apply.mock.invocationCallOrder[0]);
```

- [ ] **Step 3: Run and confirm RED**

Run: `npm test -- --runInBand tests/unit/VaultChangeApplier.test.ts tests/unit/AgentRunService.test.ts`

Expected: FAIL because approval and applier are absent.

- [ ] **Step 4: Implement the closed registry**

```ts
type OperationExecutorMap = {
  move: OperationExecutor<MoveVaultChangeOperation>;
  archive: OperationExecutor<ArchiveVaultChangeOperation>;
  setProperty: OperationExecutor<SetPropertyVaultChangeOperation>;
  replaceAnchored: OperationExecutor<ReplaceAnchoredVaultChangeOperation>;
};

interface PreparedVaultEffect {
  apply(): Promise<void>;
  readback(): Promise<Record<string, unknown>>;
  rollback(): Promise<void>;
}

interface OperationExecutor<TOperation extends VaultChangeOperation> {
  prepare(operation: TOperation, context: { runId: string; operationId: string }):
    Promise<PreparedVaultEffect>;
}
```

The registry is a literal object keyed by the four discriminated-union values;
never resolve a model-provided agent/tool name. `VaultChangePreconditions`
resolves paths through `normalizePath`; rejects any model-supplied path whose
first segment starts with `.`, or that equals/is below `_Base/Dados` or
`_Base/PluginsSync`; checks `exists`; and for file preconditions computes
`sha256:` over the exact UTF-8 bytes returned by `vault.read()` immediately
before `apply()`. The generated `.archive/...` destination is not model-supplied
and is the only hidden-path exception.

The production executors use Obsidian `Vault`/`FileManager` primitives already
used by the storage/content tools. `move` captures source and destination and
renames back on rollback. `archive` chooses and records one concrete
`.archive/YYYY-MM-DD_HH-mm-ss/<original-path>` destination before applying and
renames it back on rollback. `setProperty` and `replaceAnchored` capture the
entire original file text and restore those exact bytes with `vault.process()`
on rollback. Every readback checks the post-effect paths/content/property, not
only the return value of the write call. No effect or rollback is retried.

Validate the selected IDs as a unique set, require every selected operation's
dependencies to be selected, and execute in the plan's already-validated
topological order. A failed operation blocks its transitive dependents but does
not stop independent selected operations.

- [ ] **Step 5: Append approval, result, and readback events**

`AgentRunService.approveAndApply()` rereads the immutable assistant plan message,
parses it against the run identity, recomputes `planHash`, and requires both the
persisted and requested hashes to match while status is `awaiting_approval`.
Persist an `approval` assistant event containing only the plan hash, selected
IDs and typed human context, then CAS the run to `applying`, before any effect.
Append one typed result event per operation. CAS to `completed` only when every
selected operation is `succeeded`; any other operation status produces
`completed_with_issues`. If approval-event persistence or the applying CAS
fails, execute zero effects.

- [ ] **Step 6: Run Task 6 tests**

Run: `npm test -- --runInBand tests/unit/VaultChangeApplier.test.ts tests/unit/AgentRunService.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit --skipLibCheck`

Run: `npx eslint src/services/workflows/VaultChangeApplier.ts src/services/workflows/VaultChangePreconditions.ts src/services/workflows/AgentRunService.ts`

Run: `npm run build`

Run: `git diff --check`

Expected: every command exits 0.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/services/workflows/VaultChangeApplier.ts src/services/workflows/VaultChangePreconditions.ts src/services/workflows/AgentRunService.ts src/core/services/ServiceDefinitions.ts tests/unit/VaultChangeApplier.test.ts tests/unit/AgentRunService.test.ts
git commit -m "feat: apply approved vault change plans"
```

---

### Task 7: Review the Agent runs UI mockup

**Files:**
- Create: `docs/mockups/supervised-agent-runs.html`
- Create when needed: `docs/mockups/supervised-agent-runs.css`
- Create when needed: `docs/mockups/supervised-agent-runs.js`

**Interfaces:**
- Consumes: approved design and the run/plan DTOs from Tasks 4–6.
- Produces: a user-approved interaction contract for Nexus Agent runs and the
  ThinkBox cockpit.
- Consumed by: runtime Task 8 and ThinkBox Task 3.

- [ ] **Step 1: Use the repository mockup workflow**

Invoke the `nexus-ui-mockups` skill before creating the preview. Reuse Nexus
visual language and realistic copy; label all persistence and execution as
simulated.

- [ ] **Step 2: Build the interactive preview**

Cover workflow selection, preflight, running, awaiting approval, exact operation
selection, confirmation, partial results, stale precondition, rollback failure,
recommendations, trace details, and mobile/empty/error states. Show both Nexus
Agent runs and the narrower ThinkBox cockpit without inventing separate state.

- [ ] **Step 3: Render, inspect, and obtain user approval**

Open the standalone mockup, exercise every state, inspect keyboard flow and
responsive layout, and present screenshots or the local preview. Stop before
production UI until the user approves the interaction shape.

- [ ] **Step 4: Commit the approved mockup**

```bash
git add -f docs/mockups/supervised-agent-runs.html docs/mockups/supervised-agent-runs.css docs/mockups/supervised-agent-runs.js
git commit -m "docs: mock up supervised agent runs"
```

Omit nonexistent companion files from `git add` when the approved preview is a
single self-contained HTML file.

---

### Task 8: Public supervised-workflow service and Nexus run UI

**Files:**
- Create: `src/services/workflows/SupervisedWorkflowService.ts`
- Create: `src/ui/workflows/AgentRunsView.ts`
- Create: `src/ui/workflows/AgentRunDetailRenderer.ts`
- Modify: `src/core/services/ServiceDefinitions.ts`
- Modify: `src/main.ts`
- Modify: `src/components/workspace/WorkflowEditorRenderer.ts`
- Modify: `styles.css`
- Create: `tests/unit/SupervisedWorkflowService.test.ts`
- Create: `tests/unit/AgentRunsView.test.ts`

**Interfaces:**
- Produces the public service consumed by ThinkBox:

```ts
interface SupervisedWorkflowService {
  listWorkflows(): Promise<SupervisedWorkflowSummary[]>;
  getPreflight(workflowId: string): Promise<SupervisedPreflight>;
  start(input: { workspaceId: string; workflowId: string }): Promise<{ runId: string }>;
  getRun(runId: string): Promise<SupervisedRun>;
  listRuns(filter?: { workflowId?: string; activeOnly?: boolean }): Promise<SupervisedRun[]>;
  cancel(runId: string): Promise<SupervisedRun>;
  approveAndApply(input: ApprovalRequest): Promise<SupervisedRun>;
  openRun(runId: string): Promise<void>;
  openWorkflow(workspaceId: string, workflowId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing public-service contract tests**

Test compatible-workflow filtering, preflight, start returning before backend
completion, status reads, cancellation, approval forwarding, and errors for chat
workflows.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- --runInBand tests/unit/SupervisedWorkflowService.test.ts`

Expected: FAIL because the public service is absent.

- [ ] **Step 3: Implement and register the stable service**

Register it as `supervisedWorkflowService` through `ServiceDefinitions.ts` and
expose it through the plugin's existing `getService()` surface. Return plain DTOs;
do not leak child processes, internal tokens, Obsidian elements, or mutable
conversation objects.

- [ ] **Step 4: Write failing view tests**

```ts
expect(renderedRun.statusText).toBe('Awaiting approval');
expect(renderedRun.details).toContain('promptHash');
expect(renderedRun.details).not.toContain('capabilityToken');
expect(cancelButton.disabled).toBe(false);
```

- [ ] **Step 5: Implement Agent runs list and detail views**

Use registered DOM events, `styles.css`, Obsidian theme variables, accessible
labels, and sentence-case text. Show run identity, status, trigger, duration,
hashes, plan validation, operations, trace, stdout/stderr, approval, and readback.
Absorb the free-form experimental modal entry so there is one production path.

- [ ] **Step 6: Run Task 8 tests**

Run: `npm test -- --runInBand tests/unit/SupervisedWorkflowService.test.ts tests/unit/AgentRunsView.test.ts tests/unit/WorkflowEditorRenderer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/services/workflows/SupervisedWorkflowService.ts src/ui/workflows/AgentRunsView.ts src/ui/workflows/AgentRunDetailRenderer.ts src/core/services/ServiceDefinitions.ts src/main.ts src/components/workspace/WorkflowEditorRenderer.ts styles.css tests/unit/SupervisedWorkflowService.test.ts tests/unit/AgentRunsView.test.ts
git commit -m "feat: expose supervised workflow runs"
```

---

### Task 9: Nexus integration verification

**Files:**
- Modify only if a test exposes a defect in Tasks 1–8.

**Interfaces:**
- Verifies the complete Nexus deliverable consumed by the ThinkBox plan.

- [ ] **Step 1: Run all focused suites together**

Run:

```bash
npm test -- --runInBand \
  tests/unit/WorkspaceWorkflowExecution.test.ts \
  tests/unit/WorkflowEditorRenderer.test.ts \
  tests/unit/AgentCapabilityPolicyService.test.ts \
  tests/unit/AgentRunProxySource.test.ts \
  tests/unit/ClaudeHeadlessService.test.ts \
  tests/unit/ClaudeCliWorkflowBackend.test.ts \
  tests/unit/VaultChangePlan.test.ts \
  tests/unit/AgentRunService.test.ts \
  tests/unit/WorkflowRunService.test.ts \
  tests/unit/WorkflowScheduleService.test.ts \
  tests/unit/VaultChangeApplier.test.ts \
  tests/unit/SupervisedWorkflowService.test.ts \
  tests/unit/AgentRunsView.test.ts
```

Expected: PASS with no open handle.

- [ ] **Step 2: Run the complete Nexus suite**

Run: `npm test -- --runInBand`

Expected: PASS. If an established unrelated baseline failure reproduces on the
base commit, document exact evidence and do not broaden this plan to fix it.

- [ ] **Step 3: Run build and whitespace validation**

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Prove startup does not await CLI execution**

Run the BackgroundProcessor and scheduler integration test with a never-settling
fake backend. Expected: background startup completes, exactly one job is queued,
and no `ClaudeCliWorkflowBackend.start()` call occurs before service readiness.

- [ ] **Step 5: Inspect final scope**

Run: `git status --short` and
`git log --oneline "$(git merge-base main HEAD)"..HEAD`.

Expected: only Tasks 1–8 implementation/tests and their intentional commits.

- [ ] **Step 6: Stop at the publication gate**

Do not push, open a PR, release, deploy, reload Nexus, create live prompts, or run
against the user's live vault without a new explicit authorization.
