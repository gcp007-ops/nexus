import { TaskService } from '../services/TaskService';
import { DAGService } from '../services/DAGService';
import { TaskRepository } from '../../../database/repositories/TaskRepository';
import { ProjectRepository } from '../../../database/repositories/ProjectRepository';
import { QueryCache } from '../../../database/optimizations/QueryCache';
import type { SQLiteCacheManager } from '../../../database/storage/SQLiteCacheManager';
import type { JSONLWriter } from '../../../database/storage/JSONLWriter';
import type { OperationalTaskEvent } from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
import type { CreateTaskData, LinkType } from '../types';
import { v4 as uuid } from '../../../utils/uuid';
function identifier(value:unknown):string {if(typeof value!=='string')throw new Error('invalid_command');return value;}
export interface InteractiveMutation { kind: string; arguments: Record<string, unknown> }
export interface PreparedMutation { delta: OperationalTaskEvent[]; entityId: string; operationalHash: string }
export async function operationalSnapshot(cache: Pick<SQLiteCacheManager, 'query'>, projectId: string): Promise<unknown[]> {
  const projects = await cache.query('SELECT * FROM projects WHERE id = ? ORDER BY id', [projectId]);
  const tasks = await cache.query('SELECT * FROM tasks WHERE projectId = ? ORDER BY id', [projectId]);
  const edges = await cache.query('SELECT d.taskId,d.dependsOnTaskId FROM task_dependencies d LEFT JOIN tasks t ON t.id=d.taskId LEFT JOIN tasks target ON target.id=d.dependsOnTaskId WHERE t.projectId=? OR target.projectId=? ORDER BY d.taskId,d.dependsOnTaskId', [projectId,projectId]);
  const links = await cache.query('SELECT l.taskId,l.notePath,l.linkType FROM task_note_links l JOIN tasks t ON t.id=l.taskId WHERE t.projectId=? ORDER BY l.taskId,l.notePath', [projectId]);
  const externalChildren=await cache.query('SELECT child.id,child.projectId,child.parentTaskId FROM tasks child JOIN tasks parent ON parent.id=child.parentTaskId WHERE parent.projectId=? AND child.projectId<>parent.projectId ORDER BY child.id',[projectId]);
  return externalChildren.length ? [projects, tasks, edges, links, externalChildren] : [projects, tasks, edges, links];
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function authorityHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function projectHash(cache: Pick<SQLiteCacheManager, 'query'>, id: string): Promise<string> { return authorityHash(await operationalSnapshot(cache, id)); }
/** Reuses native business rules and repositories on a disposable SQL clone.
 * Failure after the first staged write still leaves BOTH live stores unchanged. */
export async function prepareMutation(cache: SQLiteCacheManager, projectId: string, mutation: InteractiveMutation, priorityProvenance?: {value: string;decision_ref: string;source_operation_id: string}): Promise<PreparedMutation> {
  const clone = cache.createPlanningClone(); const delta: OperationalTaskEvent[] = [];
  const writer = { appendEvent: (_path: string, data: Record<string, unknown>): Promise<OperationalTaskEvent> => {
    const event = JSON.parse(JSON.stringify({ ...data, id: uuid(), timestamp: Date.now(), deviceId: 'task-authority' })) as OperationalTaskEvent;
    delta.push(event); return Promise.resolve(event);
  } } as unknown as JSONLWriter;
  const deps = { sqliteCache: clone.cache, jsonlWriter: writer, queryCache: new QueryCache({}) };
  const projects = new ProjectRepository(deps); const tasks = new TaskRepository(deps);
  const service = new TaskService(projects, tasks, new DAGService());
  const a = mutation.arguments; let entityId = typeof a.taskId==='string'?a.taskId:typeof a.projectId==='string'?a.projectId:'';
  try {
    if (!await projects.getById(projectId)) throw new Error('invalid_command');
    const original = a.taskId ? await tasks.getById(identifier(a.taskId)) : null;
    if (a.taskId) { const task = await tasks.getById(identifier(a.taskId)); if (!task || task.projectId !== projectId) throw new Error('invalid_command'); }
    if (a.projectId && a.projectId !== projectId) throw new Error('protocol_incompatible');
    if (a.parentTaskId) { const parent = await tasks.getById(identifier(a.parentTaskId)); if (!parent || parent.projectId !== projectId) throw new Error('protocol_incompatible'); }
    switch (mutation.kind) {
      case 'createTask': entityId = await service.createTask(projectId, a as unknown as CreateTaskData); break;
      case 'updateTask': {
        const { taskId, addDependencies, removeDependencies, addNoteLinks, removeNoteLinks, ...data } = a;
        await service.updateTask(String(taskId), data);
        for (const id of (addDependencies ?? []) as string[]) await service.addDependency(String(taskId), id);
        for (const id of (removeDependencies ?? []) as string[]) await service.removeDependency(String(taskId), id);
        for (const link of (addNoteLinks ?? []) as { notePath: string; linkType?: LinkType }[]) await service.linkNote(String(taskId), link.notePath, link.linkType ?? 'reference');
        for (const path of (removeNoteLinks ?? []) as string[]) await service.unlinkNote(String(taskId), path);
        break;
      }
      case 'moveTask': await service.moveTask(identifier(a.taskId), { projectId: a.projectId as string | undefined, parentTaskId: a.parentTaskId as string | null | undefined });
        // Preserve explicit detach: the legacy service loses null as undefined.
        if (a.parentTaskId === null) await tasks.update(identifier(a.taskId), { parentTaskId: null }); break;
      case 'updateProject': await service.updateProject(projectId, a); break;
      case 'archiveProject': await service.archiveProject(projectId); break;
      case 'linkNote': if (a.action === 'unlink') await service.unlinkNote(identifier(a.taskId), String(a.notePath)); else await service.linkNote(identifier(a.taskId), String(a.notePath), (a.linkType ?? 'reference') as LinkType); break;
      default: throw new Error('protocol_incompatible');
    }
    const provenance = priorityProvenance ?? original?.metadata?.dream_priority_v1;
    if (provenance && ['createTask','updateTask'].includes(mutation.kind)) await tasks.update(entityId,{metadata:{dream_priority_v1:provenance}});
    // All edges touched in a compound update must stay in the envelope project,
    // including removals (native removeDependency historically skips this check).
    for (const event of delta) {
      if ('taskId' in event) { const task = await tasks.getById(event.taskId); if (!task || task.projectId !== projectId) throw new Error('protocol_incompatible'); }
      if ('dependsOnTaskId' in event) { const task = await tasks.getById(event.dependsOnTaskId); if (!task || task.projectId !== projectId) throw new Error('protocol_incompatible'); }
    }
    return { delta, entityId, operationalHash: await projectHash(clone.cache, projectId) };
  } finally { clone.dispose(); }
}
