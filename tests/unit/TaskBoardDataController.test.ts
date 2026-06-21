import type NexusPlugin from '../../src/main';
import type { AgentManager } from '../../src/services/AgentManager';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { AgentRegistrationService } from '../../src/services/agent/AgentRegistrationService';
import type { TaskService } from '../../src/agents/taskManager/services/TaskService';
import type { ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';
import type { NoteLink, TaskMetadata } from '../../src/database/repositories/interfaces/ITaskRepository';
import type { WorkspaceMetadata } from '../../src/types/storage/StorageTypes';
import { TaskBoardDataController } from '../../src/ui/tasks/services/TaskBoardDataController';

function createWorkspace(overrides: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata {
  return {
    id: 'ws-1',
    name: 'Workspace One',
    rootFolder: 'Workspace One',
    created: 1,
    lastAccessed: 10,
    sessionCount: 0,
    traceCount: 0,
    ...overrides
  };
}

function createProject(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Project One',
    status: 'active',
    created: 1,
    updated: 2,
    ...overrides
  };
}

function createTask(overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    title: 'Task One',
    description: '',
    status: 'todo',
    priority: 'medium',
    created: 1,
    updated: 2,
    ...overrides
  };
}

function createLink(overrides: Partial<NoteLink> = {}): NoteLink {
  return {
    taskId: 'task-1',
    notePath: 'Notes/Task One.md',
    linkType: 'reference',
    created: 1,
    ...overrides
  };
}

describe('TaskBoardDataController', () => {
  it('resolves services and loads board data with active workspace fallback and note links', async () => {
    const workspaceService = {
      getWorkspaces: jest.fn().mockResolvedValue([
        createWorkspace({ id: 'ws-1', name: 'Workspace One' }),
        createWorkspace({ id: 'ws-2', name: 'Workspace Two', isArchived: true })
      ]),
      getActiveWorkspace: jest.fn().mockResolvedValue(createWorkspace({ id: 'ws-1' }))
    } as unknown as WorkspaceService;

    const taskService = {
      listProjects: jest.fn().mockResolvedValue({
        items: [
          createProject({ id: 'proj-1', workspaceId: 'ws-1', name: 'Project One' }),
          createProject({ id: 'proj-archived', workspaceId: 'ws-1', status: 'archived' })
        ]
      }),
      listTasks: jest.fn().mockResolvedValue({
        items: [
          createTask({ id: 'task-1', projectId: 'proj-1', workspaceId: 'ws-1', title: 'Task One' })
        ],
        hasNextPage: false
      }),
      listWorkspaceTasks: jest.fn(),
      getNoteLinks: jest.fn()
        .mockResolvedValueOnce([createLink({ taskId: 'task-1' })])
    } as unknown as TaskService;

    const agentManager = {
      getAgent: jest.fn().mockReturnValue({
        getTaskService: () => taskService
      })
    } as unknown as AgentManager;

    const agentRegistrationService = {
      initializeAllAgents: jest.fn().mockResolvedValue(undefined)
    } as unknown as AgentRegistrationService;

    const plugin = {
      getService: jest.fn(async (name: string) => {
        switch (name) {
          case 'workspaceService':
            return workspaceService;
          case 'agentRegistrationService':
            return agentRegistrationService;
          case 'agentManager':
            return agentManager;
          default:
            return null;
        }
      })
    } as unknown as NexusPlugin;

    const controller = new TaskBoardDataController(plugin);

    await controller.ensureServices();
    const snapshot = await controller.loadBoardData({});

    expect(agentRegistrationService.initializeAllAgents).toHaveBeenCalledTimes(1);
    expect(agentManager.getAgent).toHaveBeenCalledWith('taskManager');
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toEqual(
      expect.objectContaining({
        id: 'task-1',
        projectName: 'Project One',
        workspaceName: 'Workspace One',
        noteLinks: [expect.objectContaining({ notePath: 'Notes/Task One.md' })]
      })
    );
    expect(snapshot.filterState.workspaceId).toBe('ws-1');
    expect(taskService.listTasks).toHaveBeenCalledWith('proj-1', {
      page: 0,
      pageSize: 200,
      includeSubtasks: true
    });
    expect(taskService.listTasks).not.toHaveBeenCalledWith('proj-archived', expect.anything());
    expect(taskService.listWorkspaceTasks).not.toHaveBeenCalled();
  });

  it('loads all task pages for visible projects instead of treating the first page as a snapshot', async () => {
    const workspaceService = {
      getWorkspaces: jest.fn().mockResolvedValue([createWorkspace({ id: 'ws-1' })]),
      getActiveWorkspace: jest.fn().mockResolvedValue(createWorkspace({ id: 'ws-1' }))
    } as unknown as WorkspaceService;

    const taskService = {
      listProjects: jest.fn().mockResolvedValue({
        items: [createProject({ id: 'proj-1', workspaceId: 'ws-1' })]
      }),
      listTasks: jest.fn()
        .mockResolvedValueOnce({
          items: [createTask({ id: 'task-page-1', projectId: 'proj-1', workspaceId: 'ws-1' })],
          hasNextPage: true
        })
        .mockResolvedValueOnce({
          items: [createTask({ id: 'task-page-2', projectId: 'proj-1', workspaceId: 'ws-1' })],
          hasNextPage: false
        }),
      listWorkspaceTasks: jest.fn(),
      getNoteLinks: jest.fn().mockResolvedValue([])
    } as unknown as TaskService;

    const plugin = {
      getService: jest.fn(async (name: string) => {
        switch (name) {
          case 'workspaceService':
            return workspaceService;
          case 'agentRegistrationService':
            return { initializeAllAgents: jest.fn().mockResolvedValue(undefined) };
          case 'agentManager':
            return {
              getAgent: jest.fn().mockReturnValue({
                getTaskService: () => taskService
              })
            };
          default:
            return null;
        }
      })
    } as unknown as NexusPlugin;

    const controller = new TaskBoardDataController(plugin);

    await controller.ensureServices();
    const snapshot = await controller.loadBoardData({});

    expect(taskService.listTasks).toHaveBeenCalledTimes(2);
    expect(taskService.listTasks).toHaveBeenNthCalledWith(1, 'proj-1', {
      page: 0,
      pageSize: 200,
      includeSubtasks: true
    });
    expect(taskService.listTasks).toHaveBeenNthCalledWith(2, 'proj-1', {
      page: 1,
      pageSize: 200,
      includeSubtasks: true
    });
    expect(snapshot.tasks.map(task => task.id)).toEqual(['task-page-1', 'task-page-2']);
  });

  it('throws when the task manager agent is unavailable', async () => {
    const plugin = {
      getService: jest.fn(async (name: string) => {
        switch (name) {
          case 'workspaceService':
            return {
              getWorkspaces: jest.fn(),
              getActiveWorkspace: jest.fn()
            } as unknown as WorkspaceService;
          case 'agentRegistrationService':
            return {
              initializeAllAgents: jest.fn().mockResolvedValue(undefined)
            } as unknown as AgentRegistrationService;
          case 'agentManager':
            return {
              getAgent: jest.fn().mockReturnValue({})
            } as unknown as AgentManager;
          default:
            return null;
        }
      })
    } as unknown as NexusPlugin;

    const controller = new TaskBoardDataController(plugin);

    await expect(controller.ensureServices()).rejects.toThrow('Task manager is not available');
  });
});
