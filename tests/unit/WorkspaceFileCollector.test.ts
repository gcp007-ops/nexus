import { WorkspaceFileCollector } from '../../src/agents/memoryManager/services/WorkspaceFileCollector';

describe('WorkspaceFileCollector', () => {
  it('falls back to vault files when the cache manager is unavailable', () => {
    const collector = new WorkspaceFileCollector();
    const result = collector.getRecentFilesInWorkspace(
      { rootFolder: 'Projects' },
      null,
      {
        vault: {
          getFiles: jest.fn().mockReturnValue([
            makeFile('Projects/old.md', 100),
            makeFile('Projects/new.md', 300),
            makeFile('Other/newer.md', 500),
            makeFile('Projects/image.png', 600, 'png')
          ])
        }
      } as never
    );

    expect(result).toEqual([
      { path: 'Projects/new.md', modified: 300 },
      { path: 'Projects/old.md', modified: 100 }
    ]);
  });

  it('treats slash root workspaces as the full vault', () => {
    const collector = new WorkspaceFileCollector();
    const result = collector.getRecentFilesInWorkspace(
      { rootFolder: '/' },
      { getRecentFiles: jest.fn().mockReturnValue([]) },
      {
        vault: {
          getFiles: jest.fn().mockReturnValue([
            makeFile('Root.md', 200),
            makeFile('Projects/new.md', 300)
          ])
        }
      } as never
    );

    expect(result).toEqual([
      { path: 'Projects/new.md', modified: 300 },
      { path: 'Root.md', modified: 200 }
    ]);
  });

  it('prefers cache results when available', () => {
    const collector = new WorkspaceFileCollector();
    const cacheManager = {
      getRecentFiles: jest.fn().mockReturnValue([
        { path: 'Projects/cache.md', modified: 700 }
      ])
    };
    const app = {
      vault: {
        getFiles: jest.fn()
      }
    };

    const result = collector.getRecentFilesInWorkspace(
      { rootFolder: 'Projects' },
      cacheManager,
      app as never
    );

    expect(result).toEqual([
      { path: 'Projects/cache.md', modified: 700 }
    ]);
    expect(app.vault.getFiles).not.toHaveBeenCalled();
  });
});

function makeFile(path: string, mtime: number, extension = 'md') {
  const name = path.split('/').pop() || path;
  return {
    path,
    name,
    extension,
    stat: {
      mtime,
      ctime: 1,
      size: 10
    }
  };
}
