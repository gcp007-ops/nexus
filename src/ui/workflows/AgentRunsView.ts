import {
  ItemView,
  Notice,
  type App,
  Component,
  type WorkspaceLeaf,
  type ViewStateResult
} from 'obsidian';
import type NexusPlugin from '../../main';
import type {
  SupervisedRun,
  SupervisedWorkflowService
} from '../../services/workflows/SupervisedWorkflowService';
import { AgentRunDetailRenderer } from './AgentRunDetailRenderer';

export const AGENT_RUNS_VIEW_TYPE = 'nexus-agent-runs';

export interface AgentRunsViewState extends Record<string, unknown> {
  runId?: string;
}

export class AgentRunsView extends ItemView {
  private service: SupervisedWorkflowService | null = null;
  private runs: SupervisedRun[] = [];
  private selectedRunId: string | null = null;
  private isClosed = false;
  private refreshInFlight: Promise<void> | null = null;
  private renderComponent: Component | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: NexusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AGENT_RUNS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Agent runs';
  }

  getIcon(): string {
    return 'workflow';
  }

  getState(): AgentRunsViewState {
    return this.selectedRunId ? { runId: this.selectedRunId } : {};
  }

  async setState(state: AgentRunsViewState, _result: ViewStateResult): Promise<void> {
    this.selectedRunId = typeof state.runId === 'string' ? state.runId : null;
    if (this.service) {
      await this.refresh();
    }
  }

  async onOpen(): Promise<void> {
    this.isClosed = false;
    this.renderLoading('Loading agent runs…');
    await this.ensureService();
    if (this.isClosed) return;
    await this.refresh();
    this.registerInterval(window.setInterval(() => {
      if (this.runs.some(run => isActive(run.status))) {
        void this.refresh();
      }
    }, 1_500));
  }

  onClose(): Promise<void> {
    this.isClosed = true;
    this.service = null;
    this.runs = [];
    this.selectedRunId = null;
    this.disposeRenderComponent();
    this.contentContainer.empty();
    return Promise.resolve();
  }

  private get contentContainer(): HTMLElement {
    return this.containerEl.children[1] as HTMLElement;
  }

  private async ensureService(): Promise<void> {
    this.service = await this.plugin.getService<SupervisedWorkflowService>('supervisedWorkflowService');
    if (!this.service) {
      throw new Error('Supervised workflow service is unavailable');
    }
  }

  private refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshNow().finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  private async refreshNow(): Promise<void> {
    if (!this.service || this.isClosed) return;
    try {
      this.runs = await this.service.listRuns();
      if (this.selectedRunId && !this.runs.some(run => run.runId === this.selectedRunId)) {
        this.runs = [await this.service.getRun(this.selectedRunId), ...this.runs];
      }
      if (!this.selectedRunId && this.runs.length > 0) {
        this.selectedRunId = this.runs[0].runId;
      }
      if (!this.isClosed) this.render();
    } catch (error) {
      if (!this.isClosed) this.renderError(errorMessage(error));
    }
  }

  private render(): void {
    const renderComponent = this.beginRender();
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-agent-runs-view');

    const header = container.createDiv({ cls: 'nexus-agent-runs-header' });
    header.createEl('h1', { text: 'Agent runs' });
    const refresh = header.createEl('button', {
      text: 'Refresh',
      attr: { 'aria-label': 'Refresh agent runs' }
    });
    renderComponent.registerDomEvent(refresh, 'click', () => void this.refresh());

    if (this.runs.length === 0) {
      container.createEl('p', {
        cls: 'nexus-agent-runs-empty',
        text: 'No supervised workflow runs have been recorded.'
      });
      return;
    }

    const layout = container.createDiv({ cls: 'nexus-agent-runs-layout' });
    const list = layout.createEl('nav', {
      cls: 'nexus-agent-runs-list',
      attr: { 'aria-label': 'Agent run history' }
    });
    for (const run of this.runs) {
      const button = list.createEl('button', {
        cls: `nexus-agent-runs-list-item${run.runId === this.selectedRunId ? ' is-selected' : ''}`,
        attr: {
          'aria-label': `Open run ${run.workflow.name}`,
          'aria-current': run.runId === this.selectedRunId ? 'true' : 'false'
        }
      });
      button.createSpan({ cls: 'nexus-agent-runs-list-name', text: run.workflow.name });
      button.createSpan({ cls: 'nexus-agent-runs-list-status', text: statusLabel(run.status) });
      button.createSpan({ cls: 'nexus-agent-runs-list-time', text: new Date(run.queuedAt).toLocaleString() });
      renderComponent.registerDomEvent(button, 'click', () => {
        this.selectedRunId = run.runId;
        this.render();
      });
    }

    const detail = layout.createDiv({ cls: 'nexus-agent-runs-detail-host' });
    const selected = this.runs.find(run => run.runId === this.selectedRunId) ?? this.runs[0];
    new AgentRunDetailRenderer({
      app: this.app,
      component: renderComponent,
      onCancel: async runId => {
        if (!this.service) return;
        await this.service.cancel(runId);
        await this.refresh();
      },
      onApprove: async (run, operationIds) => {
        if (!this.service || !run.hashes.planHash) {
          throw new Error('The immutable plan hash is unavailable');
        }
        await this.service.approveAndApply({
          runId: run.runId,
          planHash: run.hashes.planHash,
          operationIds,
          approval: {
            kind: 'human',
            source: 'nexus-ui',
            confirmedAt: Date.now()
          }
        });
        await this.refresh();
      },
      onReconcile: async runId => {
        if (!this.service) return;
        await this.service.reconcileApplying(runId);
        await this.refresh();
      }
    }).render(detail, selected);
  }

  private renderLoading(message: string): void {
    this.beginRender();
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-agent-runs-view');
    container.createDiv({ cls: 'nexus-agent-runs-loading', text: message });
  }

  private renderError(message: string): void {
    this.beginRender();
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-agent-runs-view');
    container.createEl('h1', { text: 'Agent runs' });
    container.createEl('p', {
      cls: 'nexus-agent-runs-error',
      text: `Agent runs could not be loaded: ${message}`
    });
    new Notice('Agent runs could not be loaded.');
  }

  private beginRender(): Component {
    this.disposeRenderComponent();
    const component = new Component();
    component.load();
    this.renderComponent = component;
    return component;
  }

  private disposeRenderComponent(): void {
    this.renderComponent?.unload();
    this.renderComponent = null;
  }
}

export async function openAgentRunsView(app: App, runId?: string): Promise<WorkspaceLeaf | null> {
  const leaf = app.workspace.getLeavesOfType(AGENT_RUNS_VIEW_TYPE)[0]
    ?? app.workspace.getLeaf('tab');
  if (!leaf) return null;
  await leaf.setViewState({
    type: AGENT_RUNS_VIEW_TYPE,
    active: true,
    state: runId ? { runId } : {}
  });
  await app.workspace.revealLeaf(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return leaf;
}

function isActive(status: SupervisedRun['status']): boolean {
  return status === 'queued'
    || status === 'running'
    || status === 'awaiting_approval'
    || status === 'applying';
}

function statusLabel(status: SupervisedRun['status']): string {
  return status.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
