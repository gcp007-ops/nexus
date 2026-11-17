import { Notice, type App } from 'obsidian';
import { ConfirmModal } from '../../../settings/components/ConfirmModal';
import type { LinkType } from '../../../database/repositories/interfaces/ITaskRepository';
import type { ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { TaskService } from '../../../agents/taskManager/services/TaskService';
import type { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import {
  TaskBoardEditModal,
  type TaskBoardEditableTask,
  type TaskBoardParentTaskOption,
  type TaskBoardProjectOption
} from '../TaskBoardEditModal';
import type { TaskBoardTask } from '../taskBoardTypes';

interface TaskBoardEditCoordinatorDependencies {
  app: App;
  getTaskService: () => TaskService | null;
  getProjects: () => ProjectMetadata[];
  getTasks: () => TaskBoardTask[];
  getEmbeddingService: () => EmbeddingService | undefined;
  reloadBoard: () => Promise<void>;
  renderBoard: () => void;
  onEditModalStateChange: (isOpen: boolean) => void;
  onEditModalClose: () => void;
  toDateInputValue: (timestamp?: number) => string;
  fromDateInputValue: (value: string) => number | undefined;
}

export class TaskBoardEditCoordinator {
  constructor(private readonly deps: TaskBoardEditCoordinatorDependencies) {}

  openEditModal(task: TaskBoardTask): void {
    this.deps.onEditModalStateChange(true);

    new TaskBoardEditModal(this.deps.app, {
      task: this.buildEditableTask(task),
      projects: this.buildProjectOptions(task),
      parentTasks: this.buildParentTaskOptions(task),
      embeddingSource: () => this.deps.getEmbeddingService(),
      onSave: async (updatedTask) => {
        await this.saveTaskChanges(task, updatedTask);
      },
      onClose: () => {
        this.deps.onEditModalStateChange(false);
        this.deps.onEditModalClose();
      }
    }).open();
  }

  async deleteTask(task: TaskBoardTask): Promise<void> {
    const confirmed = await ConfirmModal.confirm(this.deps.app, {
      variant: 'delete',
      title: 'Delete task?',
      body: `Delete task "${task.title}"? This also removes its dependency links and cannot be undone.`
    });
    if (!confirmed) {
      return;
    }

    const taskService = this.deps.getTaskService();
    if (!taskService) {
      new Notice('Task service is not available');
      return;
    }

    try {
      await taskService.deleteTask(task.id);
      await this.deps.reloadBoard();
      this.deps.renderBoard();
      new Notice('Task deleted');
    } catch (error) {
      console.error('[TaskBoardEditCoordinator] Failed to delete task:', error);
      new Notice('Failed to delete task');
    }
  }

  async saveTaskChanges(originalTask: TaskBoardTask, updatedTask: TaskBoardEditableTask): Promise<void> {
    const taskService = this.deps.getTaskService();
    if (!taskService) {
      throw new Error('Task service is not available');
    }

    const normalizedTags = updatedTask.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);

    const projectChanged = updatedTask.projectId !== originalTask.projectId;
    const parentChanged = (updatedTask.parentTaskId || '') !== (originalTask.parentTaskId || '');
    // Refuse unsupported transfers before committing unrelated field edits.
    if (projectChanged) await taskService.assertTaskMoveAllowed(originalTask.id, updatedTask.projectId);

    const fields = {
      title: updatedTask.title.trim(),
      description: updatedTask.description.trim() || undefined,
      status: updatedTask.status,
      priority: updatedTask.priorityExplicit || updatedTask.priority !== originalTask.priority ? updatedTask.priority : undefined,
      dueDate: this.deps.fromDateInputValue(updatedTask.dueDate),
      assignee: updatedTask.assignee.trim() || undefined,
      tags: normalizedTags.length > 0 ? normalizedTags : undefined
    };
    const originalLinks = new Map(originalTask.noteLinks.map(link => [link.notePath, link.linkType]));
    const updatedLinks = new Map<string, LinkType>(updatedTask.noteLinks
      .filter(link => link.notePath.trim()).map(link => [link.notePath.trim(), link.linkType || 'reference']));
    const removeNoteLinks = [...originalLinks.keys()].filter(path => !updatedLinks.has(path));
    const addNoteLinks = [...updatedLinks].filter(([path, type]) => originalLinks.get(path) !== type)
      .map(([notePath, linkType]) => ({ notePath, linkType }));
    const coordinated = await taskService.tryCoordinateTaskUpdate({
      taskId: originalTask.id, ...fields, addNoteLinks, removeNoteLinks,
    });
    if (!coordinated) await taskService.updateTask(originalTask.id, fields);

    // v1 keeps parent movement a separate receipted command. A failure here
    // leaves the modal draft intact; it must not pretend the first commit rolled back.
    try {
      if (projectChanged || parentChanged) {
        await taskService.moveTask(originalTask.id, {
          projectId: projectChanged ? updatedTask.projectId : undefined,
          parentTaskId: parentChanged ? (updatedTask.parentTaskId || null) : undefined
        });
      }
      if (!coordinated) {
        for (const path of removeNoteLinks) await taskService.unlinkNote(originalTask.id, path);
        for (const { notePath, linkType } of addNoteLinks) await taskService.linkNote(originalTask.id, notePath, linkType);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Task update interrupted';
      throw new Error(`${reason}. Earlier changes were saved. Your draft remains open; reload the task before retrying.`);
    }

    await this.deps.reloadBoard();
    this.deps.renderBoard();
    new Notice('Task saved');
  }

  private buildEditableTask(task: TaskBoardTask): TaskBoardEditableTask {
    return {
      id: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      dueDate: this.deps.toDateInputValue(task.dueDate),
      assignee: task.assignee || '',
      tags: task.tags?.join(', ') || '',
      parentTaskId: task.parentTaskId || '',
      noteLinks: [...task.noteLinks]
    };
  }

  private buildProjectOptions(task: TaskBoardTask): TaskBoardProjectOption[] {
    return this.deps.getProjects()
      .filter(project => project.workspaceId === task.workspaceId)
      .map<TaskBoardProjectOption>(project => ({
        id: project.id,
        name: project.name
      }));
  }

  private buildParentTaskOptions(task: TaskBoardTask): TaskBoardParentTaskOption[] {
    return this.deps.getTasks()
      .filter(candidate => candidate.workspaceId === task.workspaceId && candidate.id !== task.id)
      .map<TaskBoardParentTaskOption>(candidate => ({
        id: candidate.id,
        title: candidate.title,
        projectId: candidate.projectId
      }));
  }
}
