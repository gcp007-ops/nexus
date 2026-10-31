# Historical trace diagnostic — implementation plan

## Goal and authorization

Deliver an offline, non-destructive diagnostic for historical Nexus workspace event streams. The user requested synthetic tests and publication on a fork branch when writable, and selected delivery for later execution: do not scan ThinkBox production data in this session.

## Design

Use a standalone Node.js >=18 ESM script under scripts/, with no runtime dependencies. Read explicit data-root input, never start Nexus or its database adapters. JSONL is authoritative; SQLite is a derived cache and is excluded. Stream physical records, distinguish duplicates and conflicting event identities, measure UTF-8 bytes and report only aggregate evidence. Current-file comparison is optional and confined to an explicitly supplied vault root. Unsupported payload shapes remain unverified.

Alternative: invoke Nexus repositories or the compactor directly. Rejected here because it couples an offline diagnostic to Obsidian and write-capable database services or to an upstream feature absent from the fork. The selected byte-budget scenario is explicitly an estimate, not a migration simulation.

## Constraints and acceptance

- No mutation, deletion, rewriting, archiving, cache rebuild, network request or plugin initialization by the diagnostic.
- No payload text, excerpts, commands, target-note paths, payload hashes or arbitrary exception messages in output.
- Physical volume by workspace stream; trace and non-trace volume; trace records strictly above 65,536 bytes, excluding line terminators.
- Separate physical records from unique event identities and divergent versions of the same identity.
- Estimate metadata reduction using the 16,384-byte budget with explicit JSON escaping and archival limitations.
- Evidence of exact current-file copies and repeated bodies must not authorize dropping complete records. Preserve unknown and historical values.
- Partial scans, invalid JSON/UTF-8, malformed metadata, unrecognized files and concurrent changes must remain visible.
- Synthetic tests prove read-only behavior, privacy, boundaries, malformed input, duplicate/conflicting events and path confinement.

## Files and execution

1. scripts/audit-trace-history.test.mjs: write synthetic tests; run node --test scripts/audit-trace-history.test.mjs and observe failure before implementation.
2. scripts/audit-trace-history.mjs: implement discovery, bounded line reading, metrics, conservative preservation evidence and CLI. Run the same selected tests to green (120-second ceiling).
3. docs/diagnostics/historical-trace-audit.md: execution, interpretation, architecture references and migration prerequisites.
4. One focused independent review of privacy, counting and safety; address concrete blockers and run affected tests. Validate final diff and publish only this branch in gcp007-ops/nexus.

## Refactoring and cleanup

No refactoring of runtime services is needed: the script is additive and has no production consumers. No existing code becomes obsolete. The isolated clone is retained as the local review copy; test fixtures use temporary directories and clean up. No release version, sync workflow or dependencies are changed.

## Provenance

Fork baseline: b29f4d9575386e3c013088704b133ec9b473f59b, package version 5.16.3. Inspected TraceRepository, StorageEvents, WorkspaceMigrator, WorkspaceEventApplier, ToolCallTraceService, LegacyTraceMetadataNormalizer, ToolCliNormalizer, VaultEventStore and ShardedJsonlStreamStore. Upstream reference: 5.21.2 release and docs/plans/trace-payload-compaction-plan.md consulted on 2026-10-31. Historical issue #214 figures are not current measurements.
