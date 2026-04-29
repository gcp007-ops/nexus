import { TFile, TFolder } from 'obsidian';
import type { App, EventRef } from 'obsidian';
import {
  WorkspaceFolderWatcher,
  findWorkspaceRootMoves
} from '../../src/services/workspace/WorkspaceFolderWatcher';
import type { IndividualWorkspace } from '../../src/types/storage/StorageTypes';
import type { WorkspaceService } from '../../src/services/WorkspaceService';

type VaultRenameHandler = (file: TFile | TFolder, oldPath: string) => void;

function workspace(id: string, rootFolder: string): IndividualWorkspace {
  return {
    id,
    name: id,
    rootFolder,
    created: 1,
    lastAccessed: 1,
    isActive: true,
    sessions: {}
  };
}

function createMockApp(layoutReady = true) {
  let renameHandler: VaultRenameHandler | null = null;
  const ref: EventRef = {};
  const onLayoutReadyCallbacks: Array<() => void> = [];

  const app = {
    vault: {
      on: jest.fn((_event: string, handler: VaultRenameHandler) => {
        renameHandler = handler;
        return ref;
      }),
      offref: jest.fn()
    },
    workspace: {
      layoutReady,
      onLayoutReady: jest.fn((callback: () => void) => {
        onLayoutReadyCallbacks.push(callback);
      })
    }
  } as unknown as App;

  return {
    app,
    ref,
    fireRename: (file: TFile | TFolder, oldPath: string) => {
      renameHandler?.(file, oldPath);
    },
    flushLayoutReady: () => {
      for (const callback of onLayoutReadyCallbacks) {
        callback();
      }
    }
  };
}

describe('findWorkspaceRootMoves', () => {
  it('rewrites an exact workspace root folder move', () => {
    expect(findWorkspaceRootMoves(
      [workspace('ws-1', 'Subfolder A/Project')],
      'Subfolder A/Project',
      'Subfolder B/Project'
    )).toEqual([
      {
        workspaceId: 'ws-1',
        oldRootFolder: 'Subfolder A/Project',
        newRootFolder: 'Subfolder B/Project'
      }
    ]);
  });

  it('rewrites workspace roots under a moved parent folder', () => {
    expect(findWorkspaceRootMoves(
      [
        workspace('ws-1', 'Subfolder A/Project One'),
        workspace('ws-2', 'Subfolder A/Nested/Project Two'),
        workspace('ws-3', 'Other/Project Three')
      ],
      'Subfolder A',
      'Subfolder B'
    )).toEqual([
      {
        workspaceId: 'ws-1',
        oldRootFolder: 'Subfolder A/Project One',
        newRootFolder: 'Subfolder B/Project One'
      },
      {
        workspaceId: 'ws-2',
        oldRootFolder: 'Subfolder A/Nested/Project Two',
        newRootFolder: 'Subfolder B/Nested/Project Two'
      }
    ]);
  });

  it('does not rewrite root or sibling prefixes', () => {
    expect(findWorkspaceRootMoves(
      [
        workspace('default', '/'),
        workspace('ws-1', 'Projects/Application')
      ],
      'Projects/App',
      'Archive/App'
    )).toEqual([]);
  });
});

describe('WorkspaceFolderWatcher', () => {
  it('updates matching workspace root folders when Obsidian renames a folder', async () => {
    const workspaceService = {
      getAllWorkspaces: jest.fn().mockResolvedValue([
        workspace('ws-1', 'Subfolder A/Project'),
        workspace('ws-2', 'Unrelated/Project')
      ]),
      updateWorkspace: jest.fn().mockResolvedValue(undefined)
    } as unknown as WorkspaceService;
    const { app } = createMockApp();
    const watcher = new WorkspaceFolderWatcher(app, workspaceService);

    const moves = await watcher.handleRename(new TFolder('Subfolder B/Project'), 'Subfolder A/Project');

    expect(moves).toEqual([
      {
        workspaceId: 'ws-1',
        oldRootFolder: 'Subfolder A/Project',
        newRootFolder: 'Subfolder B/Project'
      }
    ]);
    expect(workspaceService.updateWorkspace).toHaveBeenCalledWith('ws-1', {
      rootFolder: 'Subfolder B/Project'
    });
  });

  it('ignores file renames', async () => {
    const workspaceService = {
      getAllWorkspaces: jest.fn(),
      updateWorkspace: jest.fn()
    } as unknown as WorkspaceService;
    const { app } = createMockApp();
    const watcher = new WorkspaceFolderWatcher(app, workspaceService);

    const moves = await watcher.handleRename(new TFile('Note.md', 'Subfolder B/Note.md'), 'Subfolder A/Note.md');

    expect(moves).toEqual([]);
    expect(workspaceService.getAllWorkspaces).not.toHaveBeenCalled();
  });

  it('waits for layout ready before registering the vault listener', () => {
    const workspaceService = {
      getAllWorkspaces: jest.fn(),
      updateWorkspace: jest.fn()
    } as unknown as WorkspaceService;
    const { app, flushLayoutReady } = createMockApp(false);
    const watcher = new WorkspaceFolderWatcher(app, workspaceService);

    watcher.startWhenReady();
    expect(app.vault.on).not.toHaveBeenCalled();

    flushLayoutReady();
    expect(app.vault.on).toHaveBeenCalledWith('rename', expect.any(Function));

    watcher.cleanup();
    expect(app.vault.offref).toHaveBeenCalledTimes(1);
  });
});
