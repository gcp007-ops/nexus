import { ButtonComponent, Component, Notice, Setting, TextComponent } from 'obsidian';
import type {
  WorkflowExecutionConfig,
  WorkflowCatchUpPolicy,
  WorkflowFrequency,
  WorkflowSchedule,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';
import type { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { v4 as uuidv4 } from '../../utils/uuid';
import { BoxedSection } from '../../settings/components/BoxedSection';

export type Workflow = WorkspaceWorkflow;

type SaveOrRunHandler = (workflow: Workflow) => Promise<void> | void;

const DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' }
];

const FREQUENCY_LABELS: Record<WorkflowFrequency, string> = {
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
};

const CATCH_UP_LABELS: Record<WorkflowCatchUpPolicy, string> = {
  skip: 'Skip missed runs',
  latest: 'Run latest missed',
  all: 'Run all missed'
};

export class WorkflowEditorRenderer {
  private workflow: Workflow = { id: '', name: '', when: '', steps: '' };

  constructor(
    private availablePrompts: CustomPrompt[],
    private onSave: SaveOrRunHandler,
    private onCancel: () => void,
    private onRunNow: SaveOrRunHandler,
    private component: Component,
    private currentDeviceId?: string
  ) {}

  render(container: HTMLElement, workflow: Workflow, isNew: boolean, options?: { showBackButton?: boolean }): void {
    container.empty();
    this.workflow = this.cloneWorkflow(workflow);

    const header = container.createDiv('nexus-workflow-header');

    if (options?.showBackButton !== false) {
      new ButtonComponent(header)
        .setButtonText('Back to workspace')
        .setIcon('chevron-left')
        .onClick(() => this.onCancel());
    }

    header.createEl('h2', {
      text: isNew ? 'Create workflow' : 'Edit workflow',
      cls: 'nexus-workflow-title'
    });

    const form = container.createDiv('nexus-workflow-form');

    // Identity section — workflow name + when.
    new BoxedSection(form, {
      title: 'Identity',
      titleId: 'wf-id-h',
      unbounded: true,
      body: body => {
        new Setting(body)
          .setName('Workflow name')
          .setDesc('Name this workflow.')
          .addText(text => text
            .setPlaceholder('For example, weekly blog planning')
            .setValue(this.workflow.name)
            .onChange(value => {
              this.workflow.name = value;
            }));

        new Setting(body)
          .setName('When')
          .setDesc('Describe when this workflow should be used.')
          .addText(text => text
            .setPlaceholder('Plan next week\'s posts.')
            .setValue(this.workflow.when)
            .onChange(value => {
              this.workflow.when = value;
            }));
      }
    }, this.component);

    // Prompt section — optional saved-prompt binding.
    new BoxedSection(form, {
      title: 'Prompt',
      titleId: 'wf-prompt-h',
      unbounded: true,
      body: body => {
        new Setting(body)
          .setName('Prompt')
          .setDesc('Optional saved prompt/agent to bind to this workflow.')
          .addDropdown(dropdown => {
            dropdown.addOption('', 'None');
            this.availablePrompts.forEach(prompt => {
              dropdown.addOption(prompt.id, prompt.name);
            });
            dropdown.setValue(this.workflow.promptId || '');
            dropdown.onChange(value => {
              const selectedPrompt = this.availablePrompts.find(prompt => prompt.id === value);
              this.workflow.promptId = selectedPrompt?.id;
              this.workflow.promptName = selectedPrompt?.name;
            });
          });
      }
    }, this.component);

    // Steps section — workflow-specific extra context.
    new BoxedSection(form, {
      title: 'Steps',
      titleId: 'wf-steps-h',
      unbounded: true,
      body: body => {
        new Setting(body)
          .setName('Steps')
          .setDesc('These instructions are sent as the workflow-specific extra context.')
          .addTextArea(text => {
            text.setPlaceholder('Research the topic, draft an outline, and write the first section.');
            text.setValue(this.workflow.steps);
            text.inputEl.rows = 8;
            text.onChange(value => {
              this.workflow.steps = value;
            });
          });
      }
    }, this.component);

    // Execution section — supervised CLI proposals are explicitly read-only.
    new BoxedSection(form, {
      title: 'Execution',
      titleId: 'wf-execution-h',
      unbounded: true,
      body: body => {
        let executionFields!: HTMLElement;
        new Setting(body)
          .setName('Backend')
          .setDesc('Choose the existing chat behavior or a supervised Claude CLI proposal.')
          .addDropdown(dropdown => {
            dropdown.addOption('chat', 'Nexus chat');
            dropdown.addOption('claude-cli', 'Claude CLI (supervised proposal)');
            dropdown.setValue(this.workflow.execution?.backend || 'chat');
            dropdown.onChange(value => {
              this.workflow.execution = value === 'claude-cli'
                ? this.buildClaudeExecution(this.workflow.execution)
                : undefined;
              executionFields.empty();
              this.renderExecutionFields(executionFields);
            });
          });

        executionFields = body.createDiv('nexus-workflow-execution-fields');
        this.renderExecutionFields(executionFields);
      }
    }, this.component);

    // Schedule section — the Enabled toggle lives in the header toolbar; the
    // conditional frequency fields live in the body and re-render in place.
    let scheduleFields!: HTMLElement;
    new BoxedSection(form, {
      title: 'Schedule',
      titleId: 'wf-sched-h',
      unbounded: true,
      toolbar: toolbar => {
        const toggleLabel = toolbar.createEl('label', { cls: 'ws-section-toggle' });
        const toggle = toggleLabel.createEl('input', {
          type: 'checkbox',
          attr: { 'aria-label': 'Enable schedule' }
        });
        toggle.checked = this.workflow.schedule?.enabled ?? false;
        toggleLabel.createSpan({ text: 'Enabled' });
        this.component.registerDomEvent(toggle, 'change', () => {
          this.workflow.schedule = toggle.checked
            ? this.buildEnabledSchedule(this.workflow.schedule)
            : undefined;
          this.renderScheduleFields(scheduleFields);
        });
      },
      body: body => {
        scheduleFields = body.createDiv('nexus-workflow-schedule-fields');
        this.renderScheduleFields(scheduleFields);
      }
    }, this.component);

    const actions = container.createDiv('nexus-form-actions');

    const isSupervised = this.workflow.execution?.backend === 'claude-cli';
    const runNowButton = new ButtonComponent(actions)
      .setButtonText(isSupervised ? 'Run supervised' : 'Run now')
      .setIcon('play');
    runNowButton.buttonEl.setAttribute(
      'aria-label',
      isSupervised ? 'Run supervised workflow' : 'Run workflow now'
    );
    runNowButton.onClick(() => {
      const nextWorkflow = this.validateAndBuildWorkflow();
      if (!nextWorkflow) {
        return;
      }
      void this.onRunNow(nextWorkflow);
    });

    new ButtonComponent(actions)
      .setButtonText('Save workflow')
      .setCta()
      .onClick(() => {
        const nextWorkflow = this.validateAndBuildWorkflow();
        if (!nextWorkflow) {
          return;
        }
        void this.onSave(nextWorkflow);
      });

    new ButtonComponent(actions)
      .setButtonText('Cancel')
      .onClick(() => this.onCancel());
  }

  getWorkflow(): Workflow {
    return this.cloneWorkflow(this.workflow);
  }

  private renderScheduleFields(container: HTMLElement): void {
    container.empty();

    if (!this.workflow.schedule?.enabled) {
      container.createDiv({
        cls: 'nexus-form-hint',
        text: 'Scheduling is off. This workflow can still be run manually.'
      });
      return;
    }

    const schedule = this.workflow.schedule;

    new Setting(container)
      .setName('Frequency')
      .addDropdown(dropdown => {
        for (const [value, label] of Object.entries(FREQUENCY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(schedule.frequency);
        dropdown.onChange(value => {
          schedule.frequency = value as WorkflowFrequency;
          this.applyFrequencyDefaults(schedule);
          this.renderScheduleFields(container);
        });
      });

    if (schedule.frequency === 'hourly') {
      new Setting(container)
        .setName('Every')
        .setDesc('Choose how many hours between runs.')
        .addDropdown(dropdown => {
          for (let hour = 1; hour <= 24; hour++) {
            dropdown.addOption(String(hour), `${hour} hour${hour === 1 ? '' : 's'}`);
          }
          dropdown.setValue(String(schedule.intervalHours || 1));
          dropdown.onChange(value => {
            schedule.intervalHours = Number(value);
          });
        });
    } else {
      if (schedule.frequency === 'weekly') {
        new Setting(container)
          .setName('Day of week')
          .addDropdown(dropdown => {
            for (const option of DAY_OPTIONS) {
              dropdown.addOption(option.value, option.label);
            }
            dropdown.setValue(String(schedule.dayOfWeek ?? 0));
            dropdown.onChange(value => {
              schedule.dayOfWeek = Number(value);
            });
          });
      }

      if (schedule.frequency === 'monthly') {
        new Setting(container)
          .setName('Day of month')
          .addDropdown(dropdown => {
            for (let day = 1; day <= 31; day++) {
              dropdown.addOption(String(day), String(day));
            }
            dropdown.setValue(String(schedule.dayOfMonth ?? 1));
            dropdown.onChange(value => {
              schedule.dayOfMonth = Number(value);
            });
          });
      }

      new Setting(container)
        .setName('Hour')
        .addDropdown(dropdown => {
          for (let hour = 0; hour <= 23; hour++) {
            dropdown.addOption(String(hour), String(hour).padStart(2, '0'));
          }
          dropdown.setValue(String(schedule.hour ?? 9));
          dropdown.onChange(value => {
            schedule.hour = Number(value);
          });
        });

      new Setting(container)
        .setName('Minute')
        .addDropdown(dropdown => {
          for (let minute = 0; minute <= 59; minute++) {
            dropdown.addOption(String(minute), String(minute).padStart(2, '0'));
          }
          dropdown.setValue(String(schedule.minute ?? 0));
          dropdown.onChange(value => {
            schedule.minute = Number(value);
          });
        });
    }

    new Setting(container)
      .setName('Catch up')
      .setDesc('Choose what happens if Obsidian was closed during a scheduled run.')
      .addDropdown(dropdown => {
        Object.entries(CATCH_UP_LABELS).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });
        dropdown.setValue(schedule.catchUp || 'latest');
        dropdown.onChange(value => {
          schedule.catchUp = value as WorkflowCatchUpPolicy;
        });
      });
  }

  private validateAndBuildWorkflow(): Workflow | null {
    const name = this.workflow.name.trim();
    const when = this.workflow.when.trim();
    const steps = this.workflow.steps.trim();

    if (!name || !when || !steps) {
      new Notice('Workflow name, when, and steps are required');
      return null;
    }

    if (
      this.workflow.execution?.backend === 'claude-cli'
      && !this.workflow.execution.authorityDeviceId?.trim()
    ) {
      new Notice('Workflow authority device is required');
      return null;
    }

    const prompt = this.workflow.promptId
      ? this.availablePrompts.find(item => item.id === this.workflow.promptId)
      : undefined;

    return {
      id: this.workflow.id || uuidv4(),
      name,
      when,
      steps,
      promptId: prompt?.id,
      promptName: prompt?.name,
      execution: this.workflow.execution?.backend === 'claude-cli'
        ? this.buildClaudeExecution(this.workflow.execution)
        : undefined,
      schedule: this.workflow.schedule?.enabled ? this.cloneSchedule(this.workflow.schedule) : undefined
    };
  }

  private cloneWorkflow(workflow: Workflow): Workflow {
    return {
      ...workflow,
      execution: workflow.execution ? this.cloneExecution(workflow.execution) : undefined,
      schedule: workflow.schedule ? this.cloneSchedule(workflow.schedule) : undefined
    };
  }

  private renderExecutionFields(container: HTMLElement): void {
    if (this.workflow.execution?.backend !== 'claude-cli') {
      container.createDiv({
        cls: 'nexus-form-hint',
        text: 'Nexus chat keeps the current workflow behavior.'
      });
      return;
    }

    const execution = this.workflow.execution;

    new Setting(container)
      .setName('Authority scope')
      .setDesc('Vault synced');

    let authorityInput: TextComponent | undefined;
    new Setting(container)
      .setName('Authority device')
      .setDesc('Only this Nexus device may run the synchronized workflow.')
      .addText(text => {
        authorityInput = text;
        text
          .setPlaceholder('Device ID')
          .setValue(execution.authorityDeviceId || '')
          .onChange(value => {
            execution.authorityDeviceId = value;
          });
      })
      .addButton(button => button
        .setButtonText('Use this device')
        .setDisabled(!this.currentDeviceId)
        .onClick(() => {
          if (!this.currentDeviceId) {
            return;
          }
          execution.authorityDeviceId = this.currentDeviceId;
          authorityInput?.setValue(this.currentDeviceId);
        }));

    new Setting(container)
      .setName('Model')
      .setDesc('Claude model alias for the supervised proposal.')
      .addText(text => text
        .setPlaceholder('Sonnet')
        .setValue(execution.model || 'sonnet')
        .onChange(value => {
          execution.model = value;
        }));

    new Setting(container)
      .setName('Max turns')
      .setDesc('Maximum Claude CLI turns (1–40).')
      .addDropdown(dropdown => {
        for (let turns = 1; turns <= 40; turns++) {
          dropdown.addOption(String(turns), String(turns));
        }
        dropdown.setValue(String(execution.maxTurns));
        dropdown.onChange(value => {
          execution.maxTurns = Number(value);
        });
      });

    new Setting(container)
      .setName('Timeout')
      .setDesc('Maximum runtime in minutes (1–60).')
      .addDropdown(dropdown => {
        for (let minutes = 1; minutes <= 60; minutes++) {
          dropdown.addOption(String(minutes), String(minutes));
        }
        dropdown.setValue(String(execution.timeoutMinutes));
        dropdown.onChange(value => {
          execution.timeoutMinutes = Number(value);
        });
      });

    new Setting(container)
      .setName('Capability profile')
      .setDesc('Vault read-only. The proposal cannot mutate the vault through Nexus.')
      .addDropdown(dropdown => {
        dropdown.addOption('vault-readonly', 'Vault read-only');
        dropdown.setValue('vault-readonly');
        dropdown.onChange(() => {
          execution.capabilityProfile = 'vault-readonly';
        });
      });

    new Setting(container)
      .setName('Output schema')
      .setDesc('The proposal must return a vault change plan.')
      .addDropdown(dropdown => {
        dropdown.addOption('vault-change-plan/v1', 'Vault-change-plan/v1');
        dropdown.setValue('vault-change-plan/v1');
        dropdown.onChange(() => {
          execution.outputSchema = 'vault-change-plan/v1';
        });
      });

    new Setting(container)
      .setName('Approval')
      .setDesc('Every proposal requires explicit approval before any change can be applied.');
  }

  private cloneExecution(execution: WorkflowExecutionConfig): WorkflowExecutionConfig {
    return { ...execution };
  }

  private buildClaudeExecution(execution?: Partial<WorkflowExecutionConfig>): WorkflowExecutionConfig {
    return {
      backend: 'claude-cli',
      authorityScope: 'vault-synced',
      ...(execution?.authorityDeviceId?.trim()
        ? { authorityDeviceId: execution.authorityDeviceId.trim() }
        : {}),
      model: execution?.model?.trim() || 'sonnet',
      mode: 'proposal',
      capabilityProfile: 'vault-readonly',
      outputSchema: 'vault-change-plan/v1',
      maxTurns: this.clampWorkflowLimit(execution?.maxTurns, 1, 40, 12),
      timeoutMinutes: this.clampWorkflowLimit(execution?.timeoutMinutes, 1, 60, 10),
      approvalRequired: true
    };
  }

  private clampWorkflowLimit(value: unknown, minimum: number, maximum: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
  }

  private cloneSchedule(schedule: WorkflowSchedule): WorkflowSchedule {
    return { ...schedule };
  }

  private buildEnabledSchedule(schedule?: WorkflowSchedule): WorkflowSchedule {
    const nextSchedule = schedule ? this.cloneSchedule(schedule) : {
      enabled: true,
      frequency: 'daily' as WorkflowFrequency,
      hour: 9,
      minute: 0,
      catchUp: 'latest' as WorkflowCatchUpPolicy
    };
    nextSchedule.enabled = true;
    this.applyFrequencyDefaults(nextSchedule);
    return nextSchedule;
  }

  private applyFrequencyDefaults(schedule: WorkflowSchedule): void {
    if (schedule.frequency === 'hourly') {
      schedule.intervalHours = schedule.intervalHours || 1;
      delete schedule.hour;
      delete schedule.minute;
      delete schedule.dayOfWeek;
      delete schedule.dayOfMonth;
      return;
    }

    schedule.hour = schedule.hour ?? 9;
    schedule.minute = schedule.minute ?? 0;
    delete schedule.intervalHours;

    if (schedule.frequency === 'weekly') {
      schedule.dayOfWeek = schedule.dayOfWeek ?? 0;
      delete schedule.dayOfMonth;
      return;
    }

    if (schedule.frequency === 'monthly') {
      schedule.dayOfMonth = schedule.dayOfMonth ?? 1;
      delete schedule.dayOfWeek;
      return;
    }

    delete schedule.dayOfWeek;
    delete schedule.dayOfMonth;
  }
}
