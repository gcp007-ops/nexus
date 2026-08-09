# Supervised Agent Workflows — Implementation Roadmap

The approved design spans two repositories and a live-vault rollout. Execute it
as three plans, in order:

1. [Nexus runtime](2026-08-09-supervised-agent-workflows-nexus-runtime.md) —
   produces a stable `supervisedWorkflowService`, read-only Claude CLI backend,
   structured plans, approval, applier, and Nexus run UI.
2. [ThinkBox cockpit](2026-08-09-supervised-agent-workflows-thinkbox-cockpit.md)
   — consumes that public service without spawning processes or duplicating run
   state.
3. [Rollout and cutover](2026-08-09-supervised-agent-workflows-rollout-cutover.md)
   — publishes/deploys through separate gates, creates the live prompt/workflow,
   proves a supervised cycle, and only then removes absorbed autoarchive code.

Each plan has its own verification and stop condition. A green earlier plan does
not authorize the next plan's publication, live configuration, deploy, reload,
vault mutation, or legacy deletion.
