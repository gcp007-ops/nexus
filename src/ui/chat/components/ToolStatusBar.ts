import { Component, setIcon } from 'obsidian';
import { ContextBadge } from './ContextBadge';
import { ContextTracker } from '../services/ContextTracker';
import { ToolStatusLine } from './toolStatusLine';

export interface ToolStatusBarCallbacks {
  onInspectClick?: () => void;
  onTaskClick?: () => void;
  onCompactClick?: () => void;
  onAgentClick?: () => void;
}

export interface ToolStatusEntry {
  text: string;
  state: 'present' | 'past' | 'failed';
}

export class ToolStatusBar {
  private statusBarEl: HTMLElement;
  private row1El!: HTMLElement;
  private slotEl!: HTMLElement;
  private row2El!: HTMLElement;
  private statusLine!: ToolStatusLine;
  private isDisposed = false;
  
  // Elements
  private inspectBtn!: HTMLButtonElement;
  private taskBtn!: HTMLButtonElement;
  private agentSlotEl!: HTMLElement;
  private compactBtn!: HTMLButtonElement;
  private costEl!: HTMLElement;
  
  private contextBadge!: ContextBadge;

  constructor(
    container: HTMLElement,
    private readonly contextTracker: ContextTracker,
    callbacks: ToolStatusBarCallbacks,
    private readonly component: Component
  ) {
    this.statusBarEl = container.createEl('div', {
      cls: 'tool-status-bar tool-status-bar-hidden'
    });

    // Setup row 1 (primary)
    this.row1El = this.statusBarEl.createEl('div', { cls: 'tool-status-row--primary' });
    this.slotEl = this.row1El.createEl('div', { cls: 'tool-status-slot' });
    this.statusLine = new ToolStatusLine(this.slotEl, this.component);
    
    // Setup row 2 (meta)
    this.row2El = this.statusBarEl.createEl('div', { cls: 'tool-status-row--meta' });
    
    // Action icons
    this.inspectBtn = this.row2El.createEl('button', { cls: 'tool-status-inspect-icon' });
    this.inspectBtn.setAttribute('aria-label', 'Tool history');
    this.inspectBtn.setAttribute('title', 'Tool history');
    setIcon(this.inspectBtn, 'eye');
    if (callbacks.onInspectClick) {
      this.component.registerDomEvent(this.inspectBtn, 'click', callbacks.onInspectClick);
    }
    
    this.taskBtn = this.row2El.createEl('button', { cls: 'tool-status-task-icon' });
    this.taskBtn.setAttribute('aria-label', 'Task board');
    this.taskBtn.setAttribute('title', 'Task board');
    setIcon(this.taskBtn, 'clipboard-check');
    if (callbacks.onTaskClick) {
      this.component.registerDomEvent(this.taskBtn, 'click', callbacks.onTaskClick);
    }
    
    // Agent status — direct button, same as the other 3 icons.
    this.agentSlotEl = this.row2El.createEl('button', { cls: 'tool-status-agent-icon' });
    this.agentSlotEl.setAttribute('aria-label', 'Subagents');
    this.agentSlotEl.setAttribute('title', 'Subagents');
    setIcon(this.agentSlotEl, 'bot');
    if (callbacks.onAgentClick) {
      this.component.registerDomEvent(this.agentSlotEl, 'click', callbacks.onAgentClick);
    }
    
    this.compactBtn = this.row2El.createEl('button', { cls: 'tool-status-compact-icon' });
    this.compactBtn.setAttribute('aria-label', 'Compact context');
    this.compactBtn.setAttribute('title', 'Compact context');
    setIcon(this.compactBtn, 'library');
    if (callbacks.onCompactClick) {
      this.component.registerDomEvent(this.compactBtn, 'click', callbacks.onCompactClick);
    }
    
    // Right group
    this.costEl = this.row2El.createEl('div', { cls: 'tool-status-cost' });
    this.contextBadge = new ContextBadge(this.row2El);
  }

  public pushStatus(entry: ToolStatusEntry): void {
    this.show();
    this.statusLine.update(entry.text, entry.state);
  }

  public clearStatus(): void {
    this.statusLine.clear();
  }

  public show(): void {
    this.statusBarEl.removeClass('tool-status-bar-hidden');
  }

  public hide(): void {
    this.statusBarEl.addClass('tool-status-bar-hidden');
  }
  
  public getAgentSlotEl(): HTMLElement {
    // Return a detached div so AgentStatusMenu.render() doesn't empty/replace
    // the real bot icon button. The bot icon is permanent; the modal opens
    // via the onAgentClick callback, not via AgentStatusMenu's click handler.
    return document.createElement('div');
  }
  
  public getContextBadge(): ContextBadge {
    return this.contextBadge;
  }
  
  public async updateContext(): Promise<void> {
    if (this.isDisposed) return;
    const usage = await this.contextTracker.getContextUsage();
    // Obsidian Component.onClose() does not await — the view may have torn
    // down during the await above, leaving us holding detached DOM refs.
    if (this.isDisposed) return;
    this.contextBadge.setPercentage(usage.percentage);

    const cost = this.contextTracker.getConversationCost();
    if (cost && cost.totalCost !== undefined) {
      this.costEl.textContent = `$${cost.totalCost.toFixed(2)}`;
    } else {
      this.costEl.textContent = '$0.00';
    }

    this.show();
  }

  public cleanup(): void {
    this.isDisposed = true;
    this.statusLine.clear();
    this.contextBadge?.cleanup();
    if (this.statusBarEl && this.statusBarEl.parentElement) {
      this.statusBarEl.parentElement.removeChild(this.statusBarEl);
    }
  }
}
