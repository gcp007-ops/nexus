/**
 * WorkspacesTab - Workspace list and detail view
 *
 * Features:
 * - List view showing all workspaces with status badges
 * - Detail view with 3 sub-tabs (Basic Info, Context, Agent & Files)
 * - Workflow editing with dedicated view
 * - Auto-save on all changes
 */

import { App, Notice, ButtonComponent, Component } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { BackButton } from '../components/BackButton';
import { WorkspaceFormRenderer } from '../../components/workspace/WorkspaceFormRenderer';
import { WorkflowEditorRenderer, Workflow } from '../../components/workspace/WorkflowEditorRenderer';
import { FilePickerRenderer } from '../../components/workspace/FilePickerRenderer';
import { ProjectWorkspace } from '../../database/workspace-types';
import { WorkspaceService } from '../../services/WorkspaceService';
import { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { CardManager, CardItem } from '../../components/CardManager';
import { v4 as uuidv4 } from '../../utils/uuid';
import type { ServiceManager } from '../../core/ServiceManager';
import type { WorkflowRunService } from '../../services/workflows/WorkflowRunService';

export interface WorkspacesTabServices {
    app: App;
    workspaceService?: WorkspaceService;
    customPromptStorage?: CustomPromptStorageService;
    prefetchedWorkspaces?: ProjectWorkspace[] | null;
    serviceManager?: ServiceManager;
    component?: Component;
}

type WorkspacesView = 'list' | 'detail' | 'workflow' | 'filepicker';

export class WorkspacesTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private services: WorkspacesTabServices;
    private workspaces: ProjectWorkspace[] = [];
    private currentWorkspace: Partial<ProjectWorkspace> | null = null;
    private currentWorkflowIndex: number = -1;
    private currentFileIndex: number = -1;
    private currentView: WorkspacesView = 'list';

    // Renderers
    private formRenderer?: WorkspaceFormRenderer;
    private workflowRenderer?: WorkflowEditorRenderer;
    private filePickerRenderer?: FilePickerRenderer;

    // Auto-save debounce
    private saveTimeout?: ReturnType<typeof setTimeout>;

    // Card manager for list view
    private cardManager?: CardManager<CardItem>;

    // Loading state
    private isLoading: boolean = true;

    constructor(
        container: HTMLElement,
        router: SettingsRouter,
        services: WorkspacesTabServices
    ) {
        this.container = container;
        this.router = router;
        this.services = services;

        // Check if we have prefetched data (array, even if empty)
        if (Array.isArray(services.prefetchedWorkspaces)) {
            // Use prefetched data - no loading needed
            this.workspaces = services.prefetchedWorkspaces!;
            this.isLoading = false;
            this.render();
        } else {
            // Render immediately with loading state
            this.render();

            // Load data in background
            this.loadWorkspaces().then(() => {
                this.isLoading = false;
                this.render();
            });
        }
    }

    /**
     * Load workspaces from service, awaiting initialization if needed
     */
    private async loadWorkspaces(): Promise<void> {
        let workspaceService = this.services.workspaceService;

        // Wait for both workspaceService and hybridStorageAdapter concurrently.
        // The adapter takes ~3s (WASM loading delay); without it, getAllWorkspaces()
        // falls back to JSONL which only has the default workspace.
        if (this.services.serviceManager) {
            const timeout = <T>(ms: number) => new Promise<T | undefined>(r => setTimeout(() => r(undefined), ms));
            try {
                const [service] = await Promise.all([
                    Promise.race([
                        this.services.serviceManager.getService<WorkspaceService>('workspaceService'),
                        timeout<WorkspaceService>(10000)
                    ]),
                    Promise.race([
                        this.services.serviceManager.getService('hybridStorageAdapter'),
                        timeout(10000)
                    ])
                ]);
                if (service) {
                    workspaceService = service as WorkspaceService;
                    this.services.workspaceService = workspaceService;
                }
            } catch (e) {
                // Service unavailable — fall through to show empty state
            }
        }

        if (!workspaceService) {
            return;
        }

        try {
            this.workspaces = await workspaceService.getAllWorkspaces();
        } catch (error) {
            console.error('[WorkspacesTab] Failed to load workspaces:', error);
            this.workspaces = [];
        }
    }

    /**
     * Main render method
     */
    render(): void {
        this.container.empty();

        const state = this.router.getState();

        // Check router state for navigation
        if (state.view === 'detail' && state.detailId) {
            this.currentView = 'detail';
            const workspace = this.workspaces.find(w => w.id === state.detailId);
            if (workspace) {
                this.currentWorkspace = { ...workspace };
                this.renderDetail();
                return;
            }
        }

        // Default to list view
        this.currentView = 'list';
        this.renderList();
    }

    /**
     * Render list view using CardManager
     */
    private renderList(): void {
        this.container.empty();

        // Header
        this.container.createEl('h3', { text: 'Workspaces' });
        this.container.createEl('p', {
            text: 'Organize your vault into focused workspaces',
            cls: 'setting-item-description'
        });

        // Show loading skeleton while loading
        if (this.isLoading) {
            this.renderLoadingSkeleton();
            return;
        }

        // Check if service is available
        if (!this.services.workspaceService) {
            this.container.createEl('p', {
                text: 'Workspace service is initializing...',
                cls: 'nexus-loading-message'
            });
            return;
        }

        // Convert workspaces to CardItem format (defensive: filter invalid + fallback names)
        const cardItems: CardItem[] = this.workspaces
            .filter(workspace => workspace && workspace.id)
            .map(workspace => ({
                id: workspace.id,
                name: workspace.name || 'Untitled Workspace',
                description: workspace.rootFolder || '/',
                isEnabled: workspace.isActive ?? true
            }));

        // Create card manager
        this.cardManager = new CardManager({
            containerEl: this.container,
            title: 'Workspaces',
            addButtonText: '+ New Workspace',
            emptyStateText: 'No workspaces yet. Create one to get started.',
            items: cardItems,
            showToggle: true,
            onAdd: () => this.createNewWorkspace(),
            onToggle: async (item, enabled) => {
                const workspace = this.workspaces.find(w => w.id === item.id);
                if (workspace && this.services.workspaceService) {
                    await this.services.workspaceService.updateWorkspace(item.id, { isActive: enabled });
                    workspace.isActive = enabled;
                }
            },
            onEdit: (item) => {
                this.router.showDetail(item.id);
            },
            onDelete: async (item) => {
                const confirmed = confirm(`Delete workspace "${item.name}"? This cannot be undone.`);
                if (!confirmed) return;

                try {
                    if (this.services.workspaceService) {
                        await this.services.workspaceService.deleteWorkspace(item.id);
                        this.workspaces = this.workspaces.filter(w => w.id !== item.id);
                        this.cardManager?.updateItems(this.workspaces.map(w => ({
                            id: w.id,
                            name: w.name,
                            description: w.rootFolder || '/',
                            isEnabled: w.isActive ?? true
                        })));
                        new Notice('Workspace deleted');
                    }
                } catch (error) {
                    console.error('[WorkspacesTab] Failed to delete workspace:', error);
                    new Notice('Failed to delete workspace');
                }
            }
        });
    }

    /**
     * Render loading skeleton cards
     */
    private renderLoadingSkeleton(): void {
        const grid = this.container.createDiv('card-manager-grid');

        // Create 3 skeleton cards
        for (let i = 0; i < 3; i++) {
            const skeleton = grid.createDiv('nexus-skeleton-card');
            skeleton.createDiv('nexus-skeleton-title');
            skeleton.createDiv('nexus-skeleton-description');
            skeleton.createDiv('nexus-skeleton-actions');
        }
    }

    /**
     * Render detail view
     */
    private renderDetail(): void {
        this.container.empty();

        if (!this.currentWorkspace) {
            this.router.back();
            return;
        }

        // Back button
        new BackButton(this.container, 'Back to Workspaces', () => {
            void this.saveCurrentWorkspace();
            this.router.back();
        });

        // Workspace name as title
        this.container.createEl('h3', {
            text: this.currentWorkspace.name || 'New Workspace',
            cls: 'nexus-detail-title'
        });

        // Get available agents
        const agents = this.getAvailableAgents();

        // Create form renderer
        const formContainer = this.container.createDiv('workspace-form-container');

        this.formRenderer = new WorkspaceFormRenderer(
            this.currentWorkspace,
            agents,
            (index) => this.openWorkflowEditor(index),
            (index) => {
                void this.runWorkflow(index);
            },
            (index) => this.openFilePicker(index),
            () => this.refreshDetail()
        );

        this.formRenderer.render(formContainer);

        // Action buttons
        const actions = this.container.createDiv('nexus-form-actions');

        // Save button
        new ButtonComponent(actions)
            .setButtonText('Save')
            .setCta()
            .onClick(async () => {
                // Cancel any pending debounced save to prevent double-save
                if (this.saveTimeout) {
                    clearTimeout(this.saveTimeout);
                    this.saveTimeout = undefined;
                }
                const savedWorkspace = await this.saveCurrentWorkspace();
                if (savedWorkspace) {
                    new Notice('Workspace saved');
                    this.router.back();
                }
            });

        // Delete button (only for existing workspaces)
        if (this.currentWorkspace.id && this.workspaces.some(w => w.id === this.currentWorkspace?.id)) {
            new ButtonComponent(actions)
                .setButtonText('Delete')
                .setWarning()
                .onClick(() => this.deleteCurrentWorkspace());
        }
    }

    /**
     * Render workflow editor view
     */
    private renderWorkflowEditor(): void {
        this.container.empty();

        if (!this.currentWorkspace || !this.currentWorkspace.context) {
            this.currentView = 'detail';
            this.renderDetail();
            return;
        }

        const workflows = this.currentWorkspace.context.workflows || [];
        const isNew = this.currentWorkflowIndex >= workflows.length || this.currentWorkflowIndex < 0;
        const workflow: Workflow = isNew
            ? { id: '', name: '', when: '', steps: '' }
            : workflows[this.currentWorkflowIndex];

        this.workflowRenderer = new WorkflowEditorRenderer(
            this.getAvailableAgents(),
            (savedWorkflow) => {
                void this.saveWorkflow(savedWorkflow);
            },
            () => {
                this.currentView = 'detail';
                this.renderDetail();
            },
            async (workflowToRun) => {
                await this.runWorkflowFromEditor(workflowToRun);
            }
        );

        this.workflowRenderer.render(this.container, workflow, isNew);
    }

    /**
     * Get available custom agents
     */
    private getAvailableAgents(): CustomPrompt[] {
        if (!this.services.customPromptStorage) return [];
        return this.services.customPromptStorage.getAllPrompts();
    }

    /**
     * Create a new workspace
     */
    private createNewWorkspace(): void {
        this.currentWorkspace = {
            id: uuidv4(),
            name: '',
            description: '',
            rootFolder: '/',
            isActive: true,
            context: {
                purpose: '',
                workflows: [],
                keyFiles: [],
                preferences: ''
            },
            created: Date.now(),
            lastAccessed: Date.now()
        };

        this.currentView = 'detail';
        this.renderDetail();
    }

    /**
     * Save the current workspace
     */
    private async saveCurrentWorkspace(): Promise<ProjectWorkspace | null> {
        if (!this.currentWorkspace || !this.services.workspaceService) return null;

        try {
            const existingIndex = this.workspaces.findIndex(w => w.id === this.currentWorkspace?.id);

            if (existingIndex >= 0) {
                // Update existing
                await this.services.workspaceService.updateWorkspace(
                    this.currentWorkspace.id!,
                    this.currentWorkspace
                );
                this.workspaces[existingIndex] = this.currentWorkspace as ProjectWorkspace;
                return this.currentWorkspace as ProjectWorkspace;
            } else {
                // Create new
                const created = await this.services.workspaceService.createWorkspace(
                    this.currentWorkspace
                );
                this.workspaces.push(created);
                this.currentWorkspace = created;
                return created;
            }
        } catch (error) {
            console.error('[WorkspacesTab] Failed to save workspace:', error);
            new Notice('Failed to save workspace');
            return null;
        }
    }

    /**
     * Delete the current workspace
     */
    private async deleteCurrentWorkspace(): Promise<void> {
        if (!this.currentWorkspace?.id || !this.services.workspaceService) return;

        const confirmed = confirm(`Delete workspace "${this.currentWorkspace.name}"? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await this.services.workspaceService.deleteWorkspace(this.currentWorkspace.id);
            this.workspaces = this.workspaces.filter(w => w.id !== this.currentWorkspace?.id);
            this.currentWorkspace = null;
            this.router.back();
            new Notice('Workspace deleted');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to delete workspace:', error);
            new Notice('Failed to delete workspace');
        }
    }

    /**
     * Open workflow editor
     */
    private openWorkflowEditor(index?: number): void {
        this.currentWorkflowIndex = index ?? -1;
        this.currentView = 'workflow';
        this.renderWorkflowEditor();
    }

    /**
     * Save workflow and return to detail view
     */
    private async saveWorkflow(workflow: Workflow, options?: {
        returnToDetail?: boolean;
        runAfterSave?: boolean;
    }): Promise<void> {
        const persistedWorkflow = await this.persistWorkflow(workflow);
        if (!persistedWorkflow) {
            return;
        }

        if (options?.runAfterSave) {
            try {
                await this.executeWorkflow(persistedWorkflow.id);
                new Notice('Workflow run started');
            } catch (error) {
                console.error('[WorkspacesTab] Failed to run workflow:', error);
                new Notice('Failed to run workflow');
            }
        }

        if (options?.returnToDetail === false) {
            this.currentView = 'workflow';
            this.renderWorkflowEditor();
            return;
        }

        this.currentView = 'detail';
        this.renderDetail();
        new Notice('Workflow saved');
    }

    /**
     * Open file picker
     */
    private openFilePicker(index: number): void {
        this.currentFileIndex = index;
        this.currentView = 'filepicker';
        this.renderFilePicker();
    }

    /**
     * Render file picker view
     */
    private renderFilePicker(): void {
        this.container.empty();

        const currentPath = this.currentWorkspace?.context?.keyFiles?.[this.currentFileIndex] || '';
        const workspaceRoot = this.currentWorkspace?.rootFolder || '/';

        this.filePickerRenderer = new FilePickerRenderer(
            this.services.app,
            (path) => {
                if (this.currentWorkspace?.context?.keyFiles) {
                    this.currentWorkspace.context.keyFiles[this.currentFileIndex] = path;
                    this.debouncedSave();
                }
                this.currentView = 'detail';
                this.renderDetail();
            },
            () => {
                this.currentView = 'detail';
                this.renderDetail();
            },
            currentPath,
            workspaceRoot,
            undefined, // title
            this.services.component
        );

        this.filePickerRenderer.render(this.container);
    }

    /**
     * Refresh the detail view
     */
    private refreshDetail(): void {
        if (this.currentView === 'detail') {
            this.renderDetail();
        }
    }

    private async runWorkflow(index: number): Promise<void> {
        const workflow = this.currentWorkspace?.context?.workflows?.[index];
        if (!workflow?.id) {
            new Notice('Save this workflow before running it');
            return;
        }

        const savedWorkspace = await this.saveCurrentWorkspace();
        if (!savedWorkspace) {
            return;
        }

        this.currentWorkspace = { ...savedWorkspace };

        try {
            await this.executeWorkflow(workflow.id);
            new Notice('Workflow run started');
        } catch (error) {
            console.error('[WorkspacesTab] Failed to run workflow:', error);
            new Notice('Failed to run workflow');
        }
    }

    private async runWorkflowFromEditor(workflow: Workflow): Promise<void> {
        await this.saveWorkflow(workflow, {
            runAfterSave: true,
            returnToDetail: false
        });
    }

    private async persistWorkflow(workflow: Workflow): Promise<Workflow | null> {
        if (!this.currentWorkspace) {
            return null;
        }

        if (!this.currentWorkspace.context) {
            this.currentWorkspace.context = {
                purpose: '',
                workflows: [],
                keyFiles: [],
                preferences: ''
            };
        }

        if (!this.currentWorkspace.context.workflows) {
            this.currentWorkspace.context.workflows = [];
        }

        const normalizedWorkflow: Workflow = {
            ...workflow,
            id: workflow.id || uuidv4(),
            promptName: workflow.promptId
                ? this.getAvailableAgents().find(prompt => prompt.id === workflow.promptId)?.name || workflow.promptName
                : undefined
        };

        const existingIndex = this.currentWorkspace.context.workflows.findIndex(item => item.id === normalizedWorkflow.id);

        if (existingIndex >= 0) {
            this.currentWorkspace.context.workflows[existingIndex] = normalizedWorkflow;
            this.currentWorkflowIndex = existingIndex;
        } else if (this.currentWorkflowIndex >= 0 && this.currentWorkflowIndex < this.currentWorkspace.context.workflows.length) {
            this.currentWorkspace.context.workflows[this.currentWorkflowIndex] = normalizedWorkflow;
        } else {
            this.currentWorkspace.context.workflows.push(normalizedWorkflow);
            this.currentWorkflowIndex = this.currentWorkspace.context.workflows.length - 1;
        }

        const savedWorkspace = await this.saveCurrentWorkspace();
        if (!savedWorkspace) {
            return null;
        }

        this.currentWorkspace = { ...savedWorkspace };
        const savedWorkflow = savedWorkspace.context?.workflows?.find(item => item.id === normalizedWorkflow.id);
        if (!savedWorkflow) {
            return normalizedWorkflow;
        }

        this.currentWorkflowIndex = savedWorkspace.context?.workflows?.findIndex(item => item.id === normalizedWorkflow.id) ?? this.currentWorkflowIndex;
        return savedWorkflow;
    }

    private async executeWorkflow(workflowId: string): Promise<void> {
        if (!this.currentWorkspace?.id) {
            throw new Error('Workspace must be saved before running a workflow');
        }

        const workflowRunService = await this.getWorkflowRunService();
        if (!workflowRunService) {
            throw new Error('Workflow run service is not available');
        }

        await workflowRunService.start({
            workspaceId: this.currentWorkspace.id,
            workflowId,
            runTrigger: 'manual',
            scheduledFor: Date.now(),
            openInChat: true
        });
    }

    private async getWorkflowRunService(): Promise<WorkflowRunService | null> {
        if (!this.services.serviceManager) {
            return null;
        }

        try {
            return await this.services.serviceManager.getService<WorkflowRunService>('workflowRunService');
        } catch {
            return null;
        }
    }

    /**
     * Debounced auto-save
     */
    private debouncedSave(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.saveCurrentWorkspace();
        }, 500);
    }

    /**
     * Cleanup
     */
    destroy(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.formRenderer?.destroy();
    }
}
