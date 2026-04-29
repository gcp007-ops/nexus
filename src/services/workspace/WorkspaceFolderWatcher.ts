/**
 * Watches Obsidian folder rename/move events and keeps workspace root paths in sync.
 */

import { TFolder, normalizePath } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import type { IndividualWorkspace } from '../../types/storage/StorageTypes';
import type { WorkspaceService } from '../WorkspaceService';

export interface WorkspaceRootMove {
  workspaceId: string;
  oldRootFolder: string;
  newRootFolder: string;
}

export class WorkspaceFolderWatcher {
  private eventRefs: EventRef[] = [];
  private started = false;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly workspaceService: WorkspaceService
  ) {}

  startWhenReady(): void {
    if (this.disposed || this.started) {
      return;
    }

    if (this.app.workspace.layoutReady) {
      this.start();
      return;
    }

    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) {
        this.start();
      }
    });
  }

  start(): void {
    if (this.disposed || this.started) {
      return;
    }

    this.started = true;
    this.eventRefs.push(
      this.app.vault.on('rename', (file, oldPath) => {
        void this.handleRename(file, oldPath).catch((error) => {
          console.error('[WorkspaceFolderWatcher] Failed to sync workspace folder rename:', error);
        });
      })
    );
  }

  cleanup(): void {
    this.disposed = true;
    this.stop();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }

    this.eventRefs = [];
    this.started = false;
  }

  async handleRename(file: TAbstractFile, oldPath: string): Promise<WorkspaceRootMove[]> {
    if (!(file instanceof TFolder)) {
      return [];
    }

    const oldFolder = normalizeWorkspacePath(oldPath);
    const newFolder = normalizeWorkspacePath(file.path);
    if (oldFolder === '/' || newFolder === '/' || oldFolder === newFolder) {
      return [];
    }

    const workspaces = await this.workspaceService.getAllWorkspaces();
    const moves = findWorkspaceRootMoves(workspaces, oldFolder, newFolder);

    for (const move of moves) {
      await this.workspaceService.updateWorkspace(move.workspaceId, {
        rootFolder: move.newRootFolder
      });
    }

    return moves;
  }
}

export function findWorkspaceRootMoves(
  workspaces: Pick<IndividualWorkspace, 'id' | 'rootFolder'>[],
  oldFolder: string,
  newFolder: string
): WorkspaceRootMove[] {
  const normalizedOld = normalizeWorkspacePath(oldFolder);
  const normalizedNew = normalizeWorkspacePath(newFolder);

  if (normalizedOld === '/' || normalizedNew === '/' || normalizedOld === normalizedNew) {
    return [];
  }

  return workspaces
    .map((workspace) => {
      const oldRootFolder = normalizeWorkspacePath(workspace.rootFolder);
      const newRootFolder = rewriteWorkspaceRoot(oldRootFolder, normalizedOld, normalizedNew);
      if (!newRootFolder || newRootFolder === oldRootFolder) {
        return null;
      }

      return {
        workspaceId: workspace.id,
        oldRootFolder,
        newRootFolder
      };
    })
    .filter((move): move is WorkspaceRootMove => move !== null);
}

function rewriteWorkspaceRoot(rootFolder: string, oldFolder: string, newFolder: string): string | null {
  if (rootFolder === '/') {
    return null;
  }

  if (rootFolder === oldFolder) {
    return newFolder;
  }

  const oldPrefix = `${oldFolder}/`;
  if (!rootFolder.startsWith(oldPrefix)) {
    return null;
  }

  return `${newFolder}/${rootFolder.slice(oldPrefix.length)}`;
}

function normalizeWorkspacePath(path: string): string {
  const normalized = normalizePath(path).trim().replace(/^\/+|\/+$/g, '');
  return normalized === '' ? '/' : normalized;
}
