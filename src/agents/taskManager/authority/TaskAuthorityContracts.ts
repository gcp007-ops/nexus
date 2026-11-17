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
    const match = /^(file|folder|repository_file|repository_directory):([A-Za-z0-9_.-]+):(.+)$/.exec(value);
    if (!match) invalid();
    const path = match![3];
    if (path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || path !== path.normalize('NFC')) invalid();
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
export function normalizeResourceList(value: unknown): string[] { resources(value); return [...value as string[]]; }
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
  if (c.type === 'commitProgress' && !['todo:in_progress','in_progress:in_progress','in_progress:done'].includes(`${String(c.expected_status)}:${String(c.next_status)}`)) invalid();
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

/** Public wire response types. Producers must also validate these at the trust boundary. */
export type AuthorityError = 'authority_unavailable' | 'revision_conflict' | 'lease_busy' | 'stale_epoch' | 'fence_rejected' | 'operation_signature_conflict' | 'effect_indeterminate' | 'capability_revoked' | 'protocol_incompatible' | 'invalid_command' | 'unauthorized';
export interface OperationIdentity { vault_scope: string; authority_id: string; project_id: string; issuer_id: string; operation_id: string; revision: number }
export type CommandOutcome =
  | { status: 'admitted'; epoch: number; baseline_hash: string }
  | { status: 'acquired'; epoch: number; lease_id: string; expires_at: string; resources: string[] }
  | { status: 'renewed'; epoch: number; lease_id: string; expires_at: string }
  | { status: 'released' }
  | { status: 'dispatched'; epoch: number; effect_id: string; dispatch_id: string }
  | { status: 'started'; dispatch_id: string; effect_id: string }
  | { status: 'confirmed' | 'rejected' | 'failed' | 'indeterminate'; effect_id: string }
  | { status: 'committed'; effect_id: string; task_id: string; receipt_ref: ArtifactRef }
  | { status: 'committed'; kind: string; entity_id: string };
export interface ArtifactRef { artifact_id: string; hash: string }
export type CommandResult = OperationIdentity & CommandOutcome;
export type QueryResult =
  | { state: 'not_found' | 'prepared' | 'dispatched' | 'started' | 'confirmed' | 'committed' | 'failed' | 'indeterminate' | 'rejected'; revision: number; result: CommandResult | null; error: AuthorityError | null }
  | { admitted: boolean; revision: number; epoch: number; resources: Array<{ resource_id: string; state: 'free' | 'leased' | 'effect_pending' | 'indeterminate'; lease_id: string | null; expires_at: string | null; effect_id: string | null }> };

export function normalizeCommandResult(value: unknown): CommandResult {
  const r=object(value);text(r.status);
  const identity=['vault_scope','authority_id','project_id','issuer_id','operation_id','revision'];
  const statuses:Record<string,string[]>={admitted:['epoch','baseline_hash'],acquired:['epoch','lease_id','expires_at','resources'],renewed:['epoch','lease_id','expires_at'],released:[],dispatched:['epoch','effect_id','dispatch_id'],started:['dispatch_id','effect_id'],confirmed:['effect_id'],rejected:['effect_id'],failed:['effect_id'],indeterminate:['effect_id'],committed:'entity_id' in r?['kind','entity_id']:['effect_id','task_id','receipt_ref']};
  const fields=statuses[r.status as string];if(!fields || !Object.prototype.hasOwnProperty.call(statuses,r.status as string))invalid();
  keys(r,[...identity,'status',...fields]);identity.slice(0,-1).forEach(k=>text(r[k]));integer(r.revision);
  for(const field of fields){if(field==='epoch')integer(r[field]);else if(field==='baseline_hash')hash(r[field]);else if(field==='resources')resources(r[field]);else if(field==='receipt_ref')artifact(r[field]);else{text(r[field]);if(field==='expires_at' && (typeof r[field]!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r[field]) || !Number.isFinite(Date.parse(r[field]))))invalid();}}
  return JSON.parse(JSON.stringify(r)) as CommandResult;
}
export function normalizeQueryResult(value:unknown):QueryResult {
  const r=object(value);
  if('admitted' in r){keys(r,['admitted','revision','epoch','resources']);if(typeof r.admitted!=='boolean')invalid();integer(r.revision);integer(r.epoch);if(!Array.isArray(r.resources))invalid();for(const row of r.resources as unknown[]){const v=object(row);keys(v,['resource_id','state','lease_id','expires_at','effect_id']);resources([v.resource_id]);oneOf(v.state,['free','leased','effect_pending','indeterminate']);for(const k of ['lease_id','expires_at','effect_id'])if(v[k]!==null)text(v[k]);}}
  else{keys(r,['state','revision','result','error']);oneOf(r.state,['not_found','prepared','dispatched','started','confirmed','committed','failed','indeterminate','rejected']);integer(r.revision);if(r.result!==null)normalizeCommandResult(r.result);if(r.error!==null)oneOf(r.error,['authority_unavailable','revision_conflict','lease_busy','stale_epoch','fence_rejected','operation_signature_conflict','effect_indeterminate','capability_revoked','protocol_incompatible','invalid_command','unauthorized']);}
  if('state' in r){if(r.error!==null&&(r.state!=='rejected'||r.result!==null))invalid();if(['not_found','prepared'].includes(String(r.state))&&(r.result!==null||r.error!==null))invalid();if(r.result!==null){const result=r.result as CommandResult;const state=['admitted','acquired','renewed','released'].includes(result.status)?'committed':result.status;if(r.state!==state||r.error!==null)invalid();}}
  return JSON.parse(JSON.stringify(r)) as QueryResult;
}

/** Internal same-process readback; never accepted as a wire query. */
export interface TaskEffectEvidence {
  protocol:'task-effect-verification/v1';vault_scope:string;authority_id:string;project_id:string;effect_id:string;dispatch_id:string;host_id:string;revision:number;
  state:'dispatched'|'started'|'confirmed'|'rejected'|'failed'|'indeterminate'|'committed';
  proposal_ref:ArtifactRef;proposal_hash:string;precondition_hash:string;capability_ref:{id:string;version:number;revision:number;hash:string};
  receipt_ref:ArtifactRef|null;receipt_hash:string|null;record_operation_id:string|null;record_operation_signature:string|null;
}

/** Advisory discovery schema; runtime normalization above remains mandatory. */
export function taskAuthorityEnvelopeSchema(query=false):import('../../../types/schema/JSONSchemaTypes').JSONSchema {
  type Schema=import('../../../types/schema/JSONSchemaTypes').JSONSchema;
  const string:Schema={type:'string',minLength:1};const int:Schema={type:'integer',minimum:0};const digest:Schema={type:'string',pattern:'^[a-f0-9]{64}$'};
  const closed=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
  const ref=closed({artifact_id:string,hash:digest});
  const field=(name:string):Schema=>name.endsWith('_hash')?digest:name==='epoch'?int:name==='lease_ms'?{type:'integer',minimum:1}:name==='resources'?{type:'array',items:string,minItems:1,uniqueItems:true}:name==='capability_ref'?closed({id:string,version:{type:'integer',minimum:1},revision:{type:'integer',minimum:1},hash:digest}):['proposal_ref','receipt_ref'].includes(name)?ref:name==='evidence_refs'?{type:'array',items:ref,minItems:1}:name==='mutation'?{oneOf:Object.entries(variants).map(([kind,spec])=>closed({kind:{const:kind},arguments:closed(Object.fromEntries([...spec.required,...spec.optional].map(k=>[k,k==='metadata'?{type:'object'}:k==='dueDate'?{type:'number'}:['tags','dependsOn','addDependencies','removeDependencies','removeMetadataKeys','removeNoteLinks'].includes(k)?{type:'array',items:string}:['linkedNotes','addNoteLinks'].includes(k)?{type:'array',items:{oneOf:[string,closed({notePath:string,linkType:{type:'string',enum:['reference','output','input']}},['notePath'])]}}:k==='parentTaskId'&&kind==='moveTask'?{type:['string','null']}:string])),spec.required)}))}:string;
  const common={protocol:{const:query?'task-authority-query/v1':'task-authority-command/v1'},vault_scope:string,authority_id:string,project_id:string,issuer_id:string};
  if(query)return {oneOf:[closed({...common,type:{const:'getOperation'},operation_id:string}),closed({...common,type:{const:'getProjectCoordination'}})]};
  return closed({...common,operation_id:string,expected_revision:int,command:{oneOf:Object.entries(specs).map(([type,fields])=>closed({type:{const:type},...Object.fromEntries(fields.map(name=>[name,field(name)]))}))}});
}
export interface TaskPriorityEvidence {protocol:'task-priority-verification/v1';vault_scope:string;authority_id:string;project_id:string;task_id:string;value:'critical'|'high'|'medium'|'low';decision_ref:string;source_operation_id:string;source_issuer_id:string;operation_signature:string;revision:number}
