import type {
  LoadWorkspaceCompactData,
  WorkspaceNavigationReference
} from '../../../database/types/workspace/ParameterTypes';
import type {
  ProjectWorkspace,
  WorkspaceWorkflow
} from '../../../database/types/workspace/WorkspaceTypes';

const OMITTED_FULL_BRANCHES = [
  'recentActivity',
  'workflows',
  'workflowDefinitions',
  'workspaceStructure',
  'recentFiles',
  'keyFiles',
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
