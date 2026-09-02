import { WorkspaceCompactResponseBuilder } from '../../src/agents/memoryManager/services/WorkspaceCompactResponseBuilder';
import type { ProjectWorkspace } from '../../src/database/types/workspace/WorkspaceTypes';

describe('WorkspaceCompactResponseBuilder', () => {
  const workspace: ProjectWorkspace = {
    id: 'ws-dev',
    name: 'Desenvolvedor',
    description: 'Executor estrutural',
    rootFolder: '_Base',
    created: 1,
    lastAccessed: 2,
    context: {
      purpose: 'Governar a vault',
      keyFiles: [
        'CLAUDE.md',
        '_Base/Workflows/Desenvolvedor/WF-Roteador.md',
        '_Base/Operacional/Changelog.md'
      ],
      preferences: 'corpo que não pode vazar',
      workflows: [{
        id: 'wf-1',
        name: 'Estrutural',
        when: 'Mudança em _Base',
        steps: 'Ver [[_Base/Workflows/Default/WF-Estrutural]]'
      }]
    }
  };

  it('returns identity and ordered navigation without material bodies', () => {
    const data = new WorkspaceCompactResponseBuilder().build(workspace);

    expect(data.context).toEqual({
      name: 'Desenvolvedor',
      description: 'Executor estrutural',
      purpose: 'Governar a vault',
      rootFolder: '_Base'
    });
    expect(data.navigation.keyFiles.map(reference => reference.path)).toEqual([
      'CLAUDE.md',
      '_Base/Workflows/Desenvolvedor/WF-Roteador.md',
      '_Base/Operacional/Changelog.md'
    ]);
    expect(data.navigation.keyFiles.map(reference => reference.mustRead)).toEqual([
      true,
      true,
      false
    ]);
    expect(data.navigation.workflows).toEqual([{
      id: 'wf-1',
      name: 'Estrutural',
      role: 'workflow',
      when: 'Mudança em _Base',
      path: '_Base/Workflows/Default/WF-Estrutural',
      mustRead: false
    }]);
    expect(JSON.stringify(data)).not.toContain('corpo que não pode vazar');
    expect(JSON.stringify(data)).not.toContain('Ver [[');
  });

  it('declares every omitted full-response branch explicitly', () => {
    const data = new WorkspaceCompactResponseBuilder().build(workspace);

    expect(data.omitted).toEqual([
      'recentActivity',
      'workflowDefinitions',
      'workspaceStructure',
      'recentFiles',
      'preferences',
      'sessions',
      'states',
      'prompt',
      'taskSummary'
    ]);
  });

  it('keeps a workflow navigable when its source link has an alias', () => {
    const aliased: ProjectWorkspace = {
      ...workspace,
      context: {
        ...workspace.context,
        workflows: [{
          id: 'wf-2',
          name: 'Retomada',
          when: 'Pedido de retomada',
          steps: 'Ver [[_Base/Workflows/Default/WF-Retomada-Default|Retomada]]'
        }]
      }
    };

    expect(new WorkspaceCompactResponseBuilder().build(aliased).navigation.workflows[0].path)
      .toBe('_Base/Workflows/Default/WF-Retomada-Default');
  });

  it('never names a delivered navigation key as omitted', () => {
    const data = new WorkspaceCompactResponseBuilder().build(workspace);

    const entregues = Object.entries(data.navigation)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([key]) => key);

    expect(entregues.length).toBeGreaterThan(0);
    for (const key of entregues) {
      expect(data.omitted).not.toContain(key);
    }
  });
});
