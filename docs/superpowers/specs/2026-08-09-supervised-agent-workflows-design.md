# Supervised agent workflows — design

**Date:** 2026-08-09

**Status:** Approved

**Primary repository:** Nexus

**Consumer:** ThinkBox

## 1. Purpose

Add a reusable, supervised agent-workflow runtime to Nexus. The initial backend
is the local Claude CLI using Sonnet, and the initial workflow is
`VaultHygiene-Agentico`.

The model investigates and proposes. Nexus enforces capabilities, persists the
run, validates the proposal, applies only explicitly approved operations, and
records readback. ThinkBox is the operational cockpit for launching runs and
approving vault effects.

This replaces growing collections of automated semantic decisions with agentic
judgment while preserving deterministic safety boundaries.

## 2. Architectural boundary

### Nexus owns

- prompt definitions and prompt resolution;
- workspace workflow definitions and schedules;
- execution backend dispatch;
- Claude CLI preflight, process lifecycle, cancellation and timeout;
- MCP capability enforcement;
- conversation, session, trace and run history;
- plan parsing, validation and hashing;
- approval and deterministic application services;
- operation readback and rollback reporting;
- detailed configuration and run-history UI.

### ThinkBox owns

- discovery of Nexus workflows eligible for supervised vault changes;
- compact run initiation and progress UI;
- human review and per-operation selection;
- approval confirmation;
- presentation of application results and readback;
- links into the corresponding Nexus configuration and run history.

ThinkBox does not own prompt text, model selection, schedules, process spawning,
run persistence, plan copies or a parallel state machine.

### The vault owns

- `CLAUDE.md`;
- skills, workflows, taxonomic authority and domain rules;
- the facts and documents inspected by the agent.

No plugin copies the operational rules into TypeScript.

## 3. Reused Nexus infrastructure

The design extends existing components instead of creating another registry:

- `CustomPromptStorageService` remains the prompt source, with the existing
  synced `data.json` representation and SQLite projection.
- `WorkspaceWorkflow` remains the workflow definition and retains `promptId`,
  `promptName` and `schedule`.
- `WorkflowRunService` remains the single entry point for manual and scheduled
  workflow runs.
- `WorkflowScheduleService` retains schedule calculation, catch-up policy and
  `runKey` deduplication within the designated scheduler authority.
- Conversations remain the durable execution record.
- `ClaudeHeadlessService` is promoted from an isolated experiment into one
  execution backend behind the workflow runtime.

The experimental free-form headless modal is absorbed by the workflow and run
interfaces. It is not a second production path.

## 4. Workflow execution configuration

`WorkspaceWorkflow` gains an optional, normalized execution configuration:

```yaml
execution:
  backend: claude-cli
  authorityScope: vault-synced
  authorityDeviceId: string
  model: sonnet
  mode: proposal
  capabilityProfile: vault-readonly
  outputSchema: vault-change-plan/v1
  maxTurns: 12
  timeoutMinutes: 10
  approvalRequired: true
```

The initial backend set is:

- `chat`: the existing Nexus conversation behavior;
- `claude-cli`: the new supervised headless backend.

The interface is backend-neutral, but only Claude CLI is added in this delivery.
Codex CLI and other runners are out of scope.

The editor validates backend-specific fields. Existing workflows without an
`execution` block preserve current behavior.

`authorityScope` separates synchronized and host-local facts:

- `vault-synced`: content and rules whose mutation propagates through vault
  synchronization;
- `machine-local`: installed skills, CLI paths, credentials, providers, caches
  and host-specific configuration.

This delivery implements applicable operations only for `vault-synced` runs.
Machine-local findings are recommendations, never global operations.

## 5. Initial workflow

Create a new saved prompt named `Guardiao da Vault` and a new workspace workflow
named `VaultHygiene-Agentico`.

The existing `CicloManutencao-Nexus` remains a deterministic, report-only
workflow. Its reports and current hygiene scans may be evidence for the agent,
but they do not decide changes.

`VaultHygiene-Agentico` starts with scheduling disabled. Its default catch-up
policy, if scheduling is later enabled, is `skip`.

This machine is the operational authority for `VaultHygiene-Agentico`. Nexus
already assigns it a stable local `claudesidian-device-id`. When scheduling is
later enabled, the workflow keeps that identifier as `authorityDeviceId`. Only
the matching device may manually start, calculate or dispatch its runs.

`MachineHygiene` is a separate, initially report-only workflow. Each machine
runs it under its own `deviceId`; its future `runKey` includes that device ID.
It may report drift in installed skills and local configuration, but it cannot
turn those findings into vault-global operations. Building the local-read
capability required by `MachineHygiene` is a follow-on delivery.

The agent must:

1. read `CLAUDE.md`;
2. load the configured workspace;
3. follow the applicable routing, skills and workflows;
4. resolve current sources of authority rather than trust stale references;
5. inspect evidence through read-only Nexus tools;
6. return one `vault-change-plan/v1` document and perform no mutation.

## 6. Execution lifecycle

The lifecycle is:

```text
queued -> running -> awaiting_approval -> applying -> completed
                     |                   |
                     -> rejected        -> completed_with_issues

running -> preflight_failed | security_blocked | invalid_output
        -> timed_out | cancelled | interrupted | failed
```

Rules:

- Manual and scheduled starts enqueue and return immediately.
- A CLI process is never awaited from Nexus or ThinkBox startup.
- The worker starts only after Nexus services are ready.
- For `vault-synced` workflows, `runKey` and single-flight prevent duplicate
  execution within the one open Nexus instance on the configured authority
  device. Other devices fail the authority gate before reserving or dispatching.
- The design does not claim distributed exactly-once execution across two
  simultaneously active instances using the same device identity. Operating
  the authority vault in more than one Obsidian process is unsupported.
- Closing a modal does not cancel a run.
- Cancellation is explicit and terminates the process tree.
- Timeout terminates the process tree and preserves partial output and trace.
- A run found as `running` after restart becomes `interrupted`; it is not retried.
- Scheduled runs may reach only `awaiting_approval`, never `applying`.

## 7. Conversation as the authoritative run

The workflow conversation is the run. `conversationId` is also `runId`.

Existing workflow metadata is retained:

- `sessionId`;
- `workspaceId`;
- `workflowId` and workflow name;
- `runTrigger`;
- `scheduledFor`;
- `runKey`.
- `authorityScope` and originating `deviceId`.

The conversation gains typed `metadata.agentRun` data:

```yaml
backend: claude-cli
status: awaiting_approval
model: sonnet
capabilityProfile: vault-readonly
promptHash: sha256:...
workflowHash: sha256:...
planHash: sha256:...
startedAt: 0
finishedAt: 0
```

At start, Nexus freezes a snapshot and hash of the resolved workflow, prompt,
model, capability profile, output schema, workspace and trigger. Later edits do
not change an existing run.

The original plan is an immutable assistant message. Approval, application and
readback are appended as later events/messages tied to `planHash`; the original
proposal is never rewritten.

Only the live process handle is ephemeral and held in memory by `runId`.

## 8. Capability enforcement

Prompt instructions are not a security boundary.

For proposal runs:

- native Claude filesystem and shell tools remain disabled;
- the CLI receives a strict MCP configuration for the current vault;
- the Claude process environment never contains the capability token;
- the token is supplied only in the temporary MCP server `env` block, so only
  the proxy child receives it;
- that configuration lives in a unique local directory with mode `0600`, is
  never synced into the vault, and is removed on every terminal path;
- failure to remove the token-bearing configuration makes the run `failed`;
- Nexus applies the `vault-readonly` profile inside tool dispatch;
- discovery hides disallowed tools where possible;
- execution rejects every disallowed agent/tool pair even if manually forged;
- mutation attempts set the run to `security_blocked` and are traced;
- the operational UI does not expose a bypass-permissions toggle.

Non-interactive CLI execution is allowed only because the Nexus boundary itself
enforces the capability profile. `--dangerously-skip-permissions` is not treated
as authorization and is not used by supervised workflow runs. Supervised runs
also use safe mode, disable native tools, and explicitly allow only the two
canonical Nexus MCP metatools.

The bearer token is ephemeral but may exist briefly in the mode-`0600` MCP
configuration as a controlled exception to the no-persistence preference. It
must never appear in Claude's environment, argv, logs, traces, DTOs,
conversation metadata, synced storage, or vault files.

ThinkBox never falls back to spawning the CLI directly. If Nexus is unavailable,
the run is unavailable.

## 9. Plan contract

The initial schema is `vault-change-plan/v1`. It contains:

- plan identity and schema version;
- run, workflow, prompt and workspace identities;
- summary and findings;
- applicable operations;
- recommendations without an authorized applier;
- evidence references;
- preservation notes.

Each operation includes:

- `operationId` and originating `findingId`;
- one allowed operation type;
- exact target parameters;
- evidence;
- current-state preconditions and content hash where applicable;
- expected effect;
- risk explanation;
- dependencies on other operation IDs;
- rollback description.

The first applier registry accepts only:

- `move`;
- `archive`;
- `setProperty`;
- `replaceAnchored`.

The plan cannot name arbitrary Nexus tools. The registry maps closed operation
types to known service calls and validates their parameters.

Schema changes, rule creation, field removal, taxonomic decisions and
TaskManager mutations are recommendations only in the initial version.

## 10. Approval and application

Approval is per operation, with batch selection in the UI.

An approval request contains:

- `runId`;
- `planHash`;
- selected operation IDs;
- approval timestamp and actor context.

Nexus rejects approval when the plan hash is unknown or changed. Before every
operation, the applier revalidates current-state preconditions.

Application is sequential. Independent operations may continue after a failure.
Dependents of a failed, stale or rolled-back operation are blocked.

Every operation receives one terminal result:

- `success`;
- `stale`;
- `failed`;
- `dependency_blocked`;
- `rolled_back`;
- `rollback_failed`.

There is no automatic retry of mutation. A changed plan requires new approval.
Readback follows each successful mutation. Failed readback attempts rollback of
that operation only and records both outcomes.

## 11. User interfaces

### Nexus

The existing workflow editor gains an `Execution` section for backend, model,
capability profile, output schema, limits and approval policy. The existing
prompt and schedule editors remain authoritative.

A new `Agent runs` view provides:

- active and historical runs;
- resolved workspace, workflow, prompt, model and hashes;
- lifecycle status, trigger and duration;
- explicit cancellation;
- conversation, trace, stdout and stderr;
- parsed plan, validation outcome, approval and application readback.

### ThinkBox

A generic `Agentes supervisionados` panel lists compatible Nexus workflows and
provides:

- Claude/Nexus readiness;
- manual run initiation;
- compact progress and cancellation;
- operation and recommendation review;
- per-operation selection;
- exact confirmation summary;
- application and readback results;
- links to configure the workflow or open the full run in Nexus.

Both interfaces use the same service, `runId`, plan and state. ThinkBox stores
no duplicate run record.

## 12. Failure behavior

- Missing CLI, auth, connector or workspace: `preflight_failed`.
- Disallowed tool attempt: `security_blocked`.
- Invalid or oversized structured output: `invalid_output`; raw output retained.
- Process exceeds deadline: `timed_out`; process tree terminated.
- User cancellation: `cancelled` only after termination is confirmed.
- Restart during execution: `interrupted`.
- Changed target before apply: operation `stale`.
- Apply failure: `failed`; no retry.
- Apply plus rollback failure: `rollback_failed` and explicit human escalation.

Failures never trigger a direct-CLI fallback, an automatic mutation, an implicit
retry or a claim of successful completion.

## 13. Migration and simplification

### Phase 1 — Nexus runtime

Promote the headless backend, add capability enforcement, lifecycle persistence,
conversation integration and run UI. Existing hygiene behavior is unchanged.

### Phase 2 — Agentic hygiene workflow

Create the prompt and workflow, validate read-only investigation and structured
plans, and keep scheduling disabled.

### Phase 3 — ThinkBox supervision

Add the generic panel and approval flow. Temporarily route the existing
`Abrir Limpeza assistida` command to `VaultHygiene-Agentico` with archive focus.

### Phase 4 — Proven cutover

After a real supervised cycle proves parity:

- remove `ManualAttemptCoordinator`;
- remove the autoarchive-specific controller, planner, modal and wiring that are
  fully absorbed;
- retain only factual scanners that provide useful evidence;
- archive superseded decision rules and scripts without erasing history;
- keep `CicloManutencao-Nexus` report-only;
- migrate `CorrectionPlan` in a separate delivery.

Legacy removal requires demonstrated archive-case coverage, approval and apply
success, rollback evidence, non-blocking startup, no exclusive legacy consumer,
and zero reproducible Critical or Important defect.

## 14. Verification strategy

### Nexus automated tests

- workflow execution normalization and backwards compatibility;
- plan parser, canonical hashing and limits;
- run state transitions and invalid transitions;
- read-only discovery and forged mutation rejection;
- process success, error, timeout, cancellation and tree termination;
- scheduler enqueue without startup blocking;
- `runKey` deduplication;
- leader-device gating for synchronized workflows and device-namespaced keys
  for machine-local reports;
- conversation persistence and interrupted-run reconciliation;
- approval hash binding;
- operation success, stale state, dependency blocking, readback and rollback;
- fake Claude executable integration covering argv, stdin, MCP config and output.

### ThinkBox automated tests

- compatible workflow discovery;
- Nexus unavailable and preflight failure;
- run progress and cancellation;
- rendering of four operation types and recommendations;
- selection, exact confirmation and approval payload;
- application/readback results;
- proof that startup initiates no workflow or CLI process.

### Integrated acceptance

- complete relevant suites and production builds in both repositories;
- startup measurement showing no CLI spawn and no awaited agent run;
- real read-only Claude run in a controlled vault;
- real apply only against reversible fixtures;
- fresh readback of conversation, plan, approval and operation results;
- commit, push, deploy and reload remain separately authorized gates.

## 15. Non-goals

- Direct, unrestricted model writes.
- Automatic approval or scheduled application.
- Provider matrix beyond the initial Claude CLI backend.
- Immediate migration of CorrectionPlan.
- Removal of deterministic factual scanners merely because an agent exists.
- Changing `CicloManutencao-Nexus` from report-only behavior.
- Implementing local filesystem/config reads for `MachineHygiene` in this
  delivery.
- Distributed scheduling or automatic failover across multiple devices.
- Deploying either plugin as part of design or implementation planning.
