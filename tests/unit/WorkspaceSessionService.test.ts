import { WorkspaceSessionService } from '../../src/services/workspace/WorkspaceSessionService';
import { createMockAdapter, createMockFileSystem, createMockIndexManager } from '../helpers/mockFactories';

describe('WorkspaceSessionService', () => {
  it('resolves missing workspace identifiers by name before creating a session', async () => {
    const adapter = createMockAdapter(true);
    const deps = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid'
      }),
      createWorkspace: jest.fn()
    };
    const service = new WorkspaceSessionService(
      createMockFileSystem() as never,
      createMockIndexManager() as never,
      adapter as never,
      deps
    );

    await service.addSession('Human Workspace Name', {
      id: 'session-1',
      name: 'Human session'
    });

    expect(deps.getWorkspaceByNameOrId).toHaveBeenCalledWith('Human Workspace Name');
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(adapter.createSession).toHaveBeenCalledWith(
      'workspace-uuid',
      expect.objectContaining({
        id: 'session-1',
        name: 'Human session'
      })
    );
  });

  it('reuses an existing Default Workspace row before attempting default creation', async () => {
    const adapter = createMockAdapter(true);
    const deps = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'existing-default-workspace'
      }),
      createWorkspace: jest.fn()
    };
    const service = new WorkspaceSessionService(
      createMockFileSystem() as never,
      createMockIndexManager() as never,
      adapter as never,
      deps
    );

    await service.addSession('default', {
      id: 'session-1',
      name: 'Default session'
    });

    expect(deps.getWorkspaceByNameOrId).toHaveBeenCalledWith('default');
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(adapter.createSession).toHaveBeenCalledWith(
      'existing-default-workspace',
      expect.objectContaining({
        id: 'session-1',
        name: 'Default session'
      })
    );
  });

  it('moves an existing default session into the selected workspace without overwriting its name', async () => {
    const adapter = createMockAdapter(true);
    adapter.getSession.mockResolvedValue({
      id: 'session-1',
      workspaceId: 'default',
      name: 'Original session',
      startTime: 123,
      isActive: true
    });
    const deps = {
      getWorkspace: jest.fn().mockResolvedValue({ id: 'workspace-uuid' }),
      getWorkspaceByNameOrId: jest.fn(),
      createWorkspace: jest.fn()
    };
    const service = new WorkspaceSessionService(
      createMockFileSystem() as never,
      createMockIndexManager() as never,
      adapter as never,
      deps
    );

    const session = await service.addSession('workspace-uuid', {
      id: 'session-1',
      name: 'Human session'
    });

    expect(adapter.moveSessionToWorkspace).toHaveBeenCalledWith('session-1', 'workspace-uuid');
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.updateSession).toHaveBeenCalledWith(
      'workspace-uuid',
      'session-1',
      expect.not.objectContaining({ name: 'Human session' })
    );
    expect(session).toEqual(expect.objectContaining({
      id: 'session-1',
      name: 'Original session'
    }));
  });

  it('treats getSession as workspace-scoped when the adapter returns another workspace', async () => {
    const adapter = createMockAdapter(true);
    adapter.getSession.mockResolvedValue({
      id: 'session-1',
      workspaceId: 'default',
      name: 'Original session'
    });
    const service = new WorkspaceSessionService(
      createMockFileSystem() as never,
      createMockIndexManager() as never,
      adapter as never,
      {
        getWorkspace: jest.fn(),
        getWorkspaceByNameOrId: jest.fn(),
        createWorkspace: jest.fn()
      }
    );

    await expect(service.getSession('workspace-uuid', 'session-1')).resolves.toBeNull();
  });
});
