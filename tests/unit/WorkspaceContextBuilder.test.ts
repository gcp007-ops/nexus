import { WorkspaceContextBuilder } from '../../src/agents/memoryManager/services/WorkspaceContextBuilder';

describe('WorkspaceContextBuilder', () => {
  it('expands useTools traces into recent tool and file activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'search search-content "workspace state", content read "Projects/A.md", content replace "Projects/A.md" "old" "new"'
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      5
    );

    expect(memoryService.getMemoryTraces).toHaveBeenCalledWith('workspace-uuid');
    expect(result.recentActivity).toEqual([
      'Updated Projects/A.md',
      'Read Projects/A.md',
      'Searched for "workspace state"'
    ]);
  });

  it('surfaces memory, storage, and task manager actions from useTools traces', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'memory create-state "checkpoint" "context" "task" --active-files "Projects/A.md" --next-steps "Continue", memory load-workspace "Product Workspace", storage move "Projects/A.md" "Archive/A.md", task create-task "proj-1" "Write tests"'
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      'Created task Write tests',
      'Moved Projects/A.md to Archive/A.md',
      'Loaded workspace Product Workspace',
      'Saved state checkpoint'
    ]);
  });

  it('uses executed batch results for serial and parallel useTools activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  strategy: 'serial',
                  tool: 'content write "Projects/A.md" "new content", content read "Projects/A.md"'
                }
              },
              legacy: {
                result: {
                  success: true,
                  data: {
                    results: [
                      { agent: 'contentManager', tool: 'write', success: true },
                      { agent: 'contentManager', tool: 'read', success: true }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      'Read Projects/A.md',
      'Wrote Projects/A.md'
    ]);
  });

  it('orders newer traces and newer batch operations before older activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 100,
            content: 'Updated Projects/old.md'
          },
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'storage create-folder "Projects/probes", content write "Projects/probes/new-file.md" "body", content replace "Projects/activity-probe.md" "old" "new", memory create-state "E2E Activity Probe State 2" "context" "task" --active-files "Projects/activity-probe.md" --next-steps "Continue"'
                }
              },
              legacy: {
                result: {
                  success: true,
                  data: {
                    results: [
                      { agent: 'storageManager', tool: 'createFolder', success: true },
                      { agent: 'contentManager', tool: 'write', success: true },
                      { agent: 'contentManager', tool: 'replace', success: true },
                      { agent: 'memoryManager', tool: 'createState', success: true }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      5
    );

    expect(result.recentActivity).toEqual([
      'Saved state E2E Activity Probe State 2',
      'Updated Projects/activity-probe.md',
      'Wrote Projects/probes/new-file.md',
      'Created folder Projects/probes',
      'Updated Projects/old.md'
    ]);
  });

  it('does not show unexecuted later commands when a serial batch stops early', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Tool execution failed',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  strategy: 'serial',
                  tool: 'content write "Projects/A.md" "new content", content read "Projects/A.md"'
                }
              },
              legacy: {
                result: {
                  success: false,
                  data: {
                    results: [
                      { agent: 'contentManager', tool: 'write', success: false }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      'Failed: Wrote Projects/A.md'
    ]);
  });
});
