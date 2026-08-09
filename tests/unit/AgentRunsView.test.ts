import { App, Component } from 'obsidian';
import type { SupervisedRun } from '../../src/services/workflows/SupervisedWorkflowService';
import {
  AgentRunDetailRenderer,
  buildAgentRunPresentation
} from '../../src/ui/workflows/AgentRunDetailRenderer';

interface MockElement {
  tagName: string;
  textContent: string;
  className: string;
  disabled: boolean;
  checked: boolean;
  type: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  children: MockElement[];
  createEl: jest.Mock;
  createDiv: jest.Mock;
  createSpan: jest.Mock;
  empty: jest.Mock;
  addClass: jest.Mock;
  setAttribute: jest.Mock;
  getAttribute: jest.Mock;
}

function element(tagName = 'div'): MockElement {
  const node: MockElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    disabled: false,
    checked: false,
    type: '',
    attrs: {},
    dataset: {},
    children: [],
    empty: jest.fn(() => { node.children = []; }),
    addClass: jest.fn((name: string) => { node.className += ` ${name}`; }),
    setAttribute: jest.fn((name: string, value: string) => { node.attrs[name] = value; }),
    getAttribute: jest.fn((name: string) => node.attrs[name] ?? null),
    createEl: jest.fn((tag: string, options?: {
      cls?: string;
      text?: string;
      type?: string;
      attr?: Record<string, string>;
    }) => {
      const child = element(tag);
      child.className = options?.cls ?? '';
      child.textContent = options?.text ?? '';
      child.type = options?.type ?? '';
      Object.assign(child.attrs, options?.attr ?? {});
      node.children.push(child);
      return child;
    }),
    createDiv: jest.fn((options?: string | { cls?: string; text?: string }) => {
      const child = element('div');
      child.className = typeof options === 'string' ? options : options?.cls ?? '';
      child.textContent = typeof options === 'object' ? options.text ?? '' : '';
      node.children.push(child);
      return child;
    }),
    createSpan: jest.fn((options?: { cls?: string; text?: string }) => {
      const child = element('span');
      child.className = options?.cls ?? '';
      child.textContent = options?.text ?? '';
      node.children.push(child);
      return child;
    })
  };
  return node;
}

function awaitingApprovalRun(): SupervisedRun {
  return {
    runId: 'run-1',
    workspace: { id: 'ws-1', name: 'Developer' },
    workflow: { id: 'wf-1', name: 'Vault hygiene' },
    prompt: { id: 'prompt-1', name: 'Vault curator' },
    status: 'awaiting_approval',
    trigger: 'manual',
    model: 'sonnet',
    queuedAt: 100,
    startedAt: 110,
    finishedAt: 150,
    durationMs: 40,
    hashes: {
      promptHash: `sha256:${'a'.repeat(64)}`,
      workflowHash: `sha256:${'b'.repeat(64)}`,
      planHash: `sha256:${'c'.repeat(64)}`
    },
    planValidation: { status: 'valid' },
    plan: {
      schema: 'vault-change-plan/v1',
      planId: 'plan-1',
      runId: 'run-1',
      workflowId: 'wf-1',
      promptHash: `sha256:${'a'.repeat(64)}`,
      workflowHash: `sha256:${'b'.repeat(64)}`,
      workspaceId: 'ws-1',
      summary: 'Archive a stale note.',
      findings: [{ findingId: 'finding-1', summary: 'Stale note', evidence: ['evidence-1'] }],
      evidenceReferences: [{ evidenceId: 'evidence-1', path: 'Inbox/Stale.md', excerpt: 'status: done' }],
      operations: [{
        operationId: 'archive-1',
        findingId: 'finding-1',
        type: 'archive',
        path: 'Inbox/Stale.md',
        evidence: ['evidence-1'],
        preconditions: [{ path: 'Inbox/Stale.md', exists: true }],
        expectedEffect: 'Move the note to the archive.',
        risk: { level: 'low', explanation: 'Reversible move.' },
        dependsOn: [],
        rollback: 'Move the note back.'
      }],
      recommendations: [{
        recommendationId: 'recommendation-1',
        findingId: 'finding-1',
        summary: 'Review backlinks later.',
        evidence: ['evidence-1']
      }],
      preservationNotes: ['Keep links valid.']
    },
    stdout: ['plan output'],
    stderr: [],
    stdoutTruncated: false,
    stderrTruncated: false,
    approval: null,
    application: null,
    trace: [{ kind: 'plan', timestamp: 150 }]
  };
}

describe('Agent runs UI', () => {
  it('presents the approved status copy and public hashes without internal capabilities', () => {
    const renderedRun = buildAgentRunPresentation(awaitingApprovalRun());

    expect(renderedRun.statusText).toBe('Awaiting approval');
    expect(renderedRun.details).toContain('promptHash');
    expect(renderedRun.details).not.toContain('capabilityToken');
    expect(renderedRun.details).not.toContain('deviceId');
  });

  it('gates cancel and approval actions from the authoritative run status', () => {
    expect(buildAgentRunPresentation({ ...awaitingApprovalRun(), status: 'running' }).canCancel).toBe(true);
    expect(buildAgentRunPresentation(awaitingApprovalRun()).canApprove).toBe(true);
    expect(buildAgentRunPresentation({ ...awaitingApprovalRun(), status: 'completed' }).canCancel).toBe(false);
  });

  it('renders accessible actions and registers every native interaction for cleanup', () => {
    const component = new Component();
    const register = jest.spyOn(component, 'registerDomEvent');
    const renderer = new AgentRunDetailRenderer({
      app: new App(),
      component,
      onCancel: jest.fn(),
      onApprove: jest.fn()
    });
    const root = element();

    const rendered = renderer.render(root as unknown as HTMLElement, awaitingApprovalRun());

    expect(rendered.cancelButton.disabled).toBe(true);
    expect(rendered.cancelButton.getAttribute('aria-label')).toBe('Cancel agent run');
    expect(rendered.approveButton?.disabled).toBe(false);
    expect(rendered.approveButton?.getAttribute('aria-label')).toBe('Review and approve selected operations');
    expect(register.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('does not expose an apply control for recommendations or rejected plans', () => {
    const component = new Component();
    const renderer = new AgentRunDetailRenderer({
      app: new App(),
      component,
      onCancel: jest.fn(),
      onApprove: jest.fn()
    });
    const rejected = {
      ...awaitingApprovalRun(),
      planValidation: { status: 'rejected' as const, message: 'Invalid schema.' }
    };

    const rendered = renderer.render(element() as unknown as HTMLElement, rejected);

    expect(rendered.approveButton).toBeNull();
    expect(rendered.operationInputs).toHaveLength(0);
  });
});
