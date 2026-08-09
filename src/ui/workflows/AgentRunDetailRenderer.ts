import { Modal, Notice, type App, type Component } from 'obsidian';
import type { SupervisedRun } from '../../services/workflows/SupervisedWorkflowService';

const STATUS_TEXT: Record<SupervisedRun['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  applying: 'Applying',
  completed: 'Completed',
  completed_with_issues: 'Completed with issues',
  rejected: 'Rejected',
  preflight_failed: 'Preflight failed',
  security_blocked: 'Security blocked',
  invalid_output: 'Invalid output',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  failed: 'Failed'
};

export interface AgentRunPresentation {
  statusText: string;
  details: string;
  canCancel: boolean;
  canApprove: boolean;
}

export interface AgentRunRenderResult {
  cancelButton: HTMLButtonElement;
  approveButton: HTMLButtonElement | null;
  operationInputs: HTMLInputElement[];
}

interface AgentRunDetailRendererDependencies {
  app: App;
  component: Component;
  onCancel(runId: string): Promise<void> | void;
  onApprove(run: SupervisedRun, operationIds: string[]): Promise<void> | void;
}

export function buildAgentRunPresentation(run: SupervisedRun): AgentRunPresentation {
  return {
    statusText: STATUS_TEXT[run.status],
    details: JSON.stringify({
      runId: run.runId,
      workspaceId: run.workspace.id,
      workflowId: run.workflow.id,
      promptId: run.prompt.id,
      model: run.model,
      trigger: run.trigger,
      durationMs: run.durationMs,
      promptHash: run.hashes.promptHash,
      workflowHash: run.hashes.workflowHash,
      planHash: run.hashes.planHash,
      planValidation: run.planValidation.status
    }),
    canCancel: run.status === 'queued'
      || run.status === 'running'
      || run.status === 'awaiting_approval',
    canApprove: run.status === 'awaiting_approval'
      && run.planValidation.status === 'valid'
      && run.plan !== null
  };
}

export class AgentRunDetailRenderer {
  constructor(private readonly dependencies: AgentRunDetailRendererDependencies) {}

  render(container: HTMLElement, run: SupervisedRun): AgentRunRenderResult {
    container.empty();
    container.addClass('nexus-agent-run-detail');
    const presentation = buildAgentRunPresentation(run);

    const header = container.createDiv({ cls: 'nexus-agent-run-detail-header' });
    header.createEl('h2', { text: run.workflow.name });
    header.createDiv({
      cls: `nexus-agent-run-status nexus-agent-run-status-${run.status}`,
      text: presentation.statusText
    });

    const identity = this.section(container, 'Run identity');
    this.fact(identity, 'Run', run.runId);
    this.fact(identity, 'Workspace', run.workspace.name || run.workspace.id);
    this.fact(identity, 'Workflow', `${run.workflow.name} (${run.workflow.id})`);
    this.fact(identity, 'Prompt', run.prompt.name || run.prompt.id || 'None');
    this.fact(identity, 'Model', run.model);
    this.fact(identity, 'Trigger', run.trigger);
    this.fact(identity, 'Duration', formatDuration(run.durationMs));

    const hashes = this.section(container, 'Immutable hashes');
    this.fact(hashes, 'promptHash', run.hashes.promptHash, true);
    this.fact(hashes, 'workflowHash', run.hashes.workflowHash, true);
    this.fact(hashes, 'planHash', run.hashes.planHash || 'Not available', true);

    const validation = this.section(container, 'Plan validation');
    validation.createDiv({
      cls: `nexus-agent-run-validation nexus-agent-run-validation-${run.planValidation.status}`,
      text: formatValidation(run)
    });

    const operationInputs = run.planValidation.status === 'valid' && run.plan
      ? this.renderPlan(container, run)
      : [];
    this.renderTrace(container, run);
    this.renderOutput(container, 'Standard output', run.stdout, run.stdoutTruncated);
    this.renderOutput(container, 'Standard error', run.stderr, run.stderrTruncated);
    this.renderApproval(container, run);
    this.renderApplication(container, run);

    const actions = container.createDiv({ cls: 'nexus-agent-run-actions' });
    const rejectsProposal = run.status === 'awaiting_approval';
    const cancelButton = actions.createEl('button', {
      text: rejectsProposal ? 'Reject proposal' : 'Cancel run',
      cls: 'nexus-agent-run-button',
      attr: { 'aria-label': rejectsProposal ? 'Reject agent proposal' : 'Cancel agent run' }
    });
    cancelButton.disabled = !presentation.canCancel;
    this.dependencies.component.registerDomEvent(cancelButton, 'click', () => {
      if (!presentation.canCancel) return;
      cancelButton.disabled = true;
      void Promise.resolve(this.dependencies.onCancel(run.runId)).catch(error => {
        cancelButton.disabled = false;
        new Notice(`${rejectsProposal ? 'Failed to reject proposal' : 'Failed to cancel run'}: ${errorMessage(error)}`);
      });
    });

    let approveButton: HTMLButtonElement | null = null;
    if (presentation.canApprove) {
      approveButton = actions.createEl('button', {
        text: 'Review approval',
        cls: 'nexus-agent-run-button mod-cta',
        attr: { 'aria-label': 'Review and approve selected operations' }
      });
      this.dependencies.component.registerDomEvent(approveButton, 'click', () => {
        const selected = operationInputs
          .filter(input => input.checked)
          .map(input => input.dataset.operationId)
          .filter((operationId): operationId is string => typeof operationId === 'string');
        if (selected.length === 0) {
          new Notice('Select at least one operation to approve.');
          return;
        }
        new AgentRunApprovalModal(this.dependencies.app, run, selected, async () => {
          await this.dependencies.onApprove(run, selected);
        }).open();
      });
    }

    return { cancelButton, approveButton, operationInputs };
  }

  private renderPlan(container: HTMLElement, run: SupervisedRun): HTMLInputElement[] {
    if (!run.plan) return [];
    const plan = this.section(container, 'Plan');
    plan.createEl('p', { text: run.plan.summary });
    const operationInputs: HTMLInputElement[] = [];
    const operations = plan.createDiv({ cls: 'nexus-agent-run-operations' });
    for (const operation of run.plan.operations) {
      const card = operations.createDiv({ cls: 'nexus-agent-run-operation' });
      const label = card.createEl('label', { cls: 'nexus-agent-run-operation-select' });
      const input = label.createEl('input', {
        type: 'checkbox',
        attr: {
          'aria-label': `Select operation ${operation.operationId}`,
          'data-operation-id': operation.operationId
        }
      });
      input.checked = true;
      input.dataset.operationId = operation.operationId;
      label.createSpan({ text: `${operation.type}: ${operation.operationId}` });
      operationInputs.push(input);
      this.dependencies.component.registerDomEvent(input, 'change', () => undefined);
      card.createEl('p', { text: operation.expectedEffect });
      this.fact(card, 'Risk', `${operation.risk.level}: ${operation.risk.explanation}`);
      this.fact(card, 'Dependencies', operation.dependsOn.join(', ') || 'None');
      this.fact(card, 'Rollback', operation.rollback);
      this.fact(card, 'Preconditions', JSON.stringify(operation.preconditions), true);
    }

    if (run.plan.recommendations.length > 0) {
      const recommendations = plan.createDiv({ cls: 'nexus-agent-run-recommendations' });
      recommendations.createEl('h4', { text: 'Recommendations' });
      for (const recommendation of run.plan.recommendations) {
        recommendations.createEl('p', {
          text: `Recommendation only: ${recommendation.summary}`
        });
      }
    }
    return operationInputs;
  }

  private renderTrace(container: HTMLElement, run: SupervisedRun): void {
    const trace = this.section(container, 'Trace');
    if (run.trace.length === 0) {
      trace.createEl('p', { text: 'No trace events recorded.' });
      return;
    }
    const list = trace.createEl('ol', { cls: 'nexus-agent-run-trace' });
    for (const event of run.trace) {
      const details = [event.kind, event.stream, event.operationId].filter(Boolean).join(' · ');
      list.createEl('li', { text: `${formatTimestamp(event.timestamp)} — ${details}` });
    }
  }

  private renderOutput(
    container: HTMLElement,
    title: string,
    chunks: string[],
    truncated: boolean
  ): void {
    const output = this.section(container, title);
    output.createEl('pre', {
      cls: 'nexus-agent-run-output',
      text: chunks.join('\n\n') || 'No output recorded.'
    });
    if (truncated) {
      output.createEl('p', {
        cls: 'nexus-agent-run-warning',
        text: 'Output was truncated and cannot be approved as a valid plan.'
      });
    }
  }

  private renderApproval(container: HTMLElement, run: SupervisedRun): void {
    const approval = this.section(container, 'Approval');
    if (!run.approval) {
      approval.createEl('p', { text: 'No approval recorded.' });
      return;
    }
    this.fact(approval, 'Source', run.approval.source);
    this.fact(approval, 'Confirmed', formatTimestamp(run.approval.confirmedAt));
    this.fact(approval, 'Operations', run.approval.operationIds.join(', ') || 'None');
  }

  private renderApplication(container: HTMLElement, run: SupervisedRun): void {
    const application = this.section(container, 'Application and readback');
    if (!run.application) {
      application.createEl('p', { text: 'No application receipt recorded.' });
      return;
    }
    for (const operation of run.application.operations) {
      const card = application.createDiv({ cls: 'nexus-agent-run-readback' });
      card.createEl('h4', { text: `${operation.operationId}: ${operation.status}` });
      this.fact(card, 'Type', operation.type);
      this.fact(card, 'Readback', operation.readback ? JSON.stringify(operation.readback) : 'Not available', true);
      if (operation.error) this.fact(card, 'Error', operation.error);
      if (operation.rollbackError) this.fact(card, 'Rollback error', operation.rollbackError);
    }
  }

  private section(container: HTMLElement, title: string): HTMLElement {
    const section = container.createEl('section', { cls: 'nexus-agent-run-section' });
    section.createEl('h3', { text: title });
    return section;
  }

  private fact(container: HTMLElement, label: string, value: string, code = false): void {
    const row = container.createDiv({ cls: 'nexus-agent-run-fact' });
    row.createSpan({ cls: 'nexus-agent-run-fact-label', text: label });
    row.createEl(code ? 'code' : 'span', { text: value });
  }
}

class AgentRunApprovalModal extends Modal {
  constructor(
    app: App,
    private readonly run: SupervisedRun,
    private readonly operationIds: string[],
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass('nexus-agent-run-approval-modal');
    this.contentEl.createEl('h2', { text: 'Approve selected operations?' });
    this.contentEl.createEl('p', {
      text: `Apply ${this.operationIds.length} selected operation${this.operationIds.length === 1 ? '' : 's'} from run ${this.run.runId}. Unselected operations will not be applied.`
    });
    const list = this.contentEl.createEl('ul');
    for (const operationId of this.operationIds) {
      list.createEl('li', { text: operationId });
    }
    this.contentEl.createEl('p', {
      cls: 'nexus-agent-run-warning',
      text: `Plan hash: ${this.run.hashes.planHash || 'Unavailable'}`
    });
    const actions = this.contentEl.createDiv({ cls: 'nexus-agent-run-actions' });
    const cancel = actions.createEl('button', {
      text: 'Cancel',
      attr: { 'aria-label': 'Cancel approval' }
    });
    this.registerModalDomEvent(cancel, 'click', () => this.close());
    const confirm = actions.createEl('button', {
      text: 'Approve and apply',
      cls: 'mod-warning',
      attr: { 'aria-label': 'Approve and apply selected operations' }
    });
    this.registerModalDomEvent(confirm, 'click', () => {
      confirm.disabled = true;
      void this.onConfirm()
        .then(() => this.close())
        .catch(error => {
          confirm.disabled = false;
          new Notice(`Approval failed: ${errorMessage(error)}`);
        });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private registerModalDomEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    (this as unknown as Component).registerDomEvent(element, type, handler as EventListener);
  }
}

function formatValidation(run: SupervisedRun): string {
  if (run.planValidation.status === 'valid') return 'Valid vault-change-plan/v1';
  if (run.planValidation.status === 'rejected') {
    return `Rejected: ${run.planValidation.message || 'The plan did not pass validation.'}`;
  }
  return 'No plan is available yet.';
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? 'In progress' : `${(durationMs / 1000).toFixed(1)} s`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
