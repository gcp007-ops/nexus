/** Closed wire validation. Authentication, canonical identity resolution, derived
 * resources and capability authorization are separate mandatory runtime gates. */
type Obj = Record<string, unknown>;
const invalid = (): never => { throw new Error('invalid_command'); };
function object(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  return value as Obj;
}
function keys(value: Obj, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(k => !allowed.has(k)) || required.some(k => !Object.prototype.hasOwnProperty.call(value, k))) invalid();
}
function text(value: unknown): void { if (typeof value !== 'string' || !value.trim()) invalid(); }
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); }
function hash(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function oneOf(value: unknown, allowed: readonly string[]): void { if (typeof value !== 'string' || !allowed.includes(value)) invalid(); }
function strings(value: unknown, nonempty = false): void {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid();
  (value as unknown[]).forEach(text);
}
function resources(value: unknown): void {
  strings(value, true);
  const list = value as string[];
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (i > 0 && list[i - 1] >= value) invalid();
    if (/^(project|task):[^:]+$/.test(value)) continue;
    const match = /^(file|folder):([^:]+):(.+)$/.exec(value);
    if (!match) invalid();
    const path = match![3];
    if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || path !== path.normalize('NFC')) invalid();
  }
}
function capability(value: unknown): void {
  const x = object(value); keys(x, ['id', 'version', 'revision', 'hash']); text(x.id); integer(x.version); integer(x.revision); if (x.version === 0 || x.revision === 0) invalid(); hash(x.hash);
}
const specs: Record<string, string[]> = {
  admitProject: ['baseline_hash'], acquireUnit: ['task_id','resources','lease_ms','capability_ref'],
  renewLease: ['lease_id','epoch','lease_ms'], releaseLease: ['lease_id','epoch'],
  dispatchEffect: ['lease_id','epoch','effect_id','capability_ref','resources','precondition_hash','proposal_ref','proposal_hash'],
  beginEffect: ['dispatch_id','effect_id','lease_id','epoch','host_id','proposal_hash'],
  recordEffect: ['dispatch_id','effect_id','receipt_ref','receipt_hash','result'],
  commitProgress: ['lease_id','epoch','effect_id','receipt_ref','task_id','expected_status','next_status','evidence_refs'],
  interactiveMutation: ['resources','mutation'],
};
const variants: Record<string, { required: string[]; optional: string[] }> = {
  createTask: { required: ['projectId','title'], optional: ['description','parentTaskId','priority','dueDate','assignee','tags','dependsOn','linkedNotes','metadata'] },
  updateTask: { required: ['taskId'], optional: ['title','description','status','priority','dueDate','assignee','tags','addDependencies','removeDependencies','addNoteLinks','removeNoteLinks','metadata','metadataMode','removeMetadataKeys'] },
  moveTask: { required: ['taskId'], optional: ['projectId','parentTaskId'] },
  updateProject: { required: ['projectId'], optional: ['name','description','status','metadata','metadataMode','removeMetadataKeys'] },
  archiveProject: { required: ['projectId'], optional: [] },
  linkNote: { required: ['taskId','notePath'], optional: ['linkType','action'] },
};
function reservedMetadata(key: string): boolean { return key === 'dream_priority_v1' || key === 'coordination' || key.startsWith('coordination_'); }
function metadata(value: unknown): void {
  const data = object(value);
  for (const key of Object.keys(data)) {
    if (reservedMetadata(key)) invalid();
  }
  // Arbitrary JSON metadata is permitted, but not non-JSON values or null.
  const check = (v: unknown): void => {
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) invalid();
    if (Array.isArray(v)) v.forEach(check); else if (v !== null && typeof v === 'object') Object.values(object(v)).forEach(check);
  };
  Object.values(data).forEach(check);
}
function link(value: unknown, allowString: boolean): void {
  if (allowString && typeof value === 'string') { text(value); return; }
  const x = object(value); keys(x, ['notePath'], ['linkType']); text(x.notePath);
  if ('linkType' in x) oneOf(x.linkType, ['reference','output','input']);
}
function artifact(value: unknown): void { const a = object(value); keys(a, ['artifact_id', 'hash']); text(a.artifact_id); hash(a.hash); }
function mutation(value: unknown): void {
  const m = object(value); keys(m, ['kind','arguments']); text(m.kind);
  const spec = variants[m.kind as string]; if (!spec || !Object.prototype.hasOwnProperty.call(variants, m.kind as string)) invalid();
  const a = object(m.arguments); keys(a, spec.required, spec.optional);
  for (const [k,v] of Object.entries(a)) {
    if (k === 'parentTaskId' && m.kind === 'moveTask' && v === null) continue;
    if (k === 'metadata') { metadata(v); continue; }
    if (k === 'dueDate') { if (typeof v !== 'number' || !Number.isFinite(v)) invalid(); continue; }
    if (['tags','dependsOn','addDependencies','removeDependencies','removeNoteLinks','removeMetadataKeys'].includes(k)) { strings(v); continue; }
    if (k === 'linkedNotes' || k === 'addNoteLinks') { if (!Array.isArray(v)) invalid(); (v as unknown[]).forEach(item => link(item, k === 'linkedNotes')); continue; }
    text(v);
    if (k === 'priority') oneOf(v, ['critical','high','medium','low']);
    if (k === 'status') oneOf(v, m.kind === 'updateProject' ? ['active','completed','archived'] : ['todo','in_progress','done','cancelled']);
    if (k === 'metadataMode') oneOf(v, ['merge','replace']);
    if (k === 'linkType') oneOf(v, ['reference','output','input']);
    if (k === 'action') oneOf(v, ['link','unlink']);
  }
  if (m.kind === 'moveTask' && !('projectId' in a) && !('parentTaskId' in a)) invalid();
  if (Array.isArray(a.removeMetadataKeys) && a.removeMetadataKeys.some(key => typeof key === 'string' && reservedMetadata(key))) invalid();
  if (a.metadataMode === 'replace' && (!('metadata' in a) || 'removeMetadataKeys' in a)) invalid();
}
export function normalizeCommand(value: unknown): Obj {
  const e = object(value); keys(e, ['protocol','vault_scope','authority_id','project_id','issuer_id','operation_id','expected_revision','command']);
  if (e.protocol !== 'task-authority-command/v1') invalid();
  ['vault_scope','authority_id','project_id','issuer_id','operation_id'].forEach(k => text(e[k])); integer(e.expected_revision);
  const c = object(e.command); text(c.type); const fields = specs[c.type as string];
  if (!fields || !Object.prototype.hasOwnProperty.call(specs, c.type as string)) invalid();
  keys(c, ['type', ...fields]);
  for (const k of fields) {
    const v = c[k];
    if (k.endsWith('_hash')) hash(v);
    else if (k === 'epoch') integer(v);
    else if (k === 'lease_ms') { integer(v); if (v === 0) invalid(); }
    else if (k === 'resources') resources(v);
    else if (k === 'capability_ref') capability(v);
    else if (k === 'mutation') mutation(v);
    else if (k === 'evidence_refs') { if (!Array.isArray(v) || v.length === 0) invalid(); (v as unknown[]).forEach(artifact); }
    else if (['proposal_ref', 'receipt_ref'].includes(k)) artifact(v);
    else if (k === 'result') oneOf(v, ['applied','base_conflict','failed','indeterminate']);
    else if (k === 'expected_status' || k === 'next_status') oneOf(v, ['todo','in_progress','done','cancelled']);
    else text(v);
  }
  if (c.type === 'commitProgress' && !['todo:in_progress','in_progress:in_progress','in_progress:done'].includes(`${c.expected_status}:${c.next_status}`)) invalid();
  return JSON.parse(JSON.stringify(e)) as Obj;
}
export function normalizeQuery(value: unknown): Obj {
  const e = object(value); text(e.type);
  const base = ['protocol','type','vault_scope','authority_id','project_id','issuer_id'];
  if (e.type === 'getOperation') keys(e, [...base, 'operation_id']);
  else if (e.type === 'getProjectCoordination') keys(e, base);
  else invalid();
  if (e.protocol !== 'task-authority-query/v1') invalid();
  base.slice(2).forEach(k => text(e[k])); if (e.type === 'getOperation') text(e.operation_id);
  return JSON.parse(JSON.stringify(e)) as Obj;
}
