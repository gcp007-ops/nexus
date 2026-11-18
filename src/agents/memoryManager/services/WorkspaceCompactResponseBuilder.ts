import type {
  LoadWorkspaceCompactData,
  WorkspaceNavigationReference
} from '../../../database/types/workspace/ParameterTypes';
import type {
  ProjectWorkspace,
  WorkspaceWorkflow
} from '../../../database/types/workspace/WorkspaceTypes';

// Ramos do briefing completo que o compacto nao carrega. Nenhum nome aqui
// pode coincidir com uma chave de `navigation`: o consumidor leria ausencia
// onde ha referencia. E nenhum ramo entra aqui sem existir no briefing
// completo: nomear a falta de algo inexistente engana do mesmo jeito.
const OMITTED_FULL_BRANCHES = [
  'recentActivity',
  'workflowDefinitions',
  'workspaceStructure',
  'recentFiles',
  'preferences',
  'sessions',
  'states',
  'prompt',
  'taskSummary'
] as const;

function fileRole(path: string): string {
  return path.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'key-file';
}

function isBootFile(path: string): boolean {
  return path === 'CLAUDE.md'
    || /(^|\/)WF-Roteador\.md$/i.test(path)
    || /(^|\/)Regras-Base-[^/]+\.md$/i.test(path);
}

function firstWikiLink(steps: string): string | undefined {
  return /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(steps)?.[1];
}

function keyFileReference(path: string): WorkspaceNavigationReference {
  return {
    path,
    role: fileRole(path),
    mustRead: isBootFile(path)
  };
}

function workflowReference(workflow: WorkspaceWorkflow): WorkspaceNavigationReference {
  return {
    id: workflow.id,
    name: workflow.name,
    role: 'workflow',
    when: workflow.when,
    path: firstWikiLink(workflow.steps),
    mustRead: false
  };
}

export class WorkspaceCompactResponseBuilder {
  build(workspace: ProjectWorkspace): LoadWorkspaceCompactData {
    return {
      context: {
        name: workspace.name,
        ...(workspace.description ? { description: workspace.description } : {}),
        ...(workspace.context?.purpose ? { purpose: workspace.context.purpose } : {}),
        rootFolder: workspace.rootFolder
      },
      navigation: {
        keyFiles: (workspace.context?.keyFiles || []).map(keyFileReference),
        workflows: (workspace.context?.workflows || []).map(workflowReference)
      },
      omitted: [...OMITTED_FULL_BRANCHES]
    };
  }
}
