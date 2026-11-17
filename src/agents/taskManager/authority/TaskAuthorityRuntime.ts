import type { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';
import type { TaskCoordinationRepository } from '../../../database/repositories/TaskCoordinationRepository';
import type { AuthorityProjectState, AuthorityLease, AuthorityEffect, AuthorityJournal, AuthorityReceipt, CoordinationCommittedEvent, OperationalTaskEvent, PriorityAssignment } from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
import { normalizeCommand, normalizeQuery, normalizeResourceList, type CommandResult, type AuthorityError, type ArtifactRef, type TaskEffectEvidence, type TaskPriorityEvidence, type TaskProjectSource, type TaskAcquisitionSelectionProject, type TaskAcquisitionSelectionRequest, type TaskAcquisitionSelectionDecision } from './TaskAuthorityContracts';
import { authorityHash, canonicalJson, type InteractiveMutation } from './TaskAuthorityPlanning';
import { serializeAuthority } from '../services/TaskCoordinationService';
import { TaskAuthorityHttpClient,validateClientConfiguration,type TaskAuthorityClientConfiguration } from './TaskAuthorityHttpClient';
import { TaskAuthorityHttpsServer,validateServerConfiguration,type TaskAuthorityServerConfiguration } from './TaskAuthorityHttpsServer';
import { v4 as uuid } from '../../../utils/uuid';
import {normalizeProgressAuthorization,type TaskProgressValidationRequest,type TaskProgressAuthorization,type TaskProgressConsumptionReadback} from './TaskAuthorityProgressContracts';
import {normalizeClosureCommand,type ClosureValidationRequest,type ClosureAuthorization} from './TaskAuthorityClosureContracts';
import {TaskAuthorityClosureService,closureRecord,closureConsumptionMatches,finiteClosure} from './TaskAuthorityClosureService';
import type {DispatchedEffectCancellation,DispatchCancellationRequest,DispatchCancellationProof} from './TaskAuthorityCancellationContracts';
type Obj = Record<string, unknown>;
export interface AuthorityAuthorization { resources: string[]; max_lease_ms: number }
export interface TaskAuthorityHostPort { releaseCommittedLease(input:CommittedLeaseRelease):Promise<unknown>; cancelDispatchedEffect(input:DispatchedEffectCancellation):Promise<unknown>; readProgressConsumption(input:{project_id:string;effect_id:string;dispatch_id:string}):Promise<TaskProgressConsumptionReadback|null>; closureCommand(envelope:unknown):Promise<unknown>;readClosure(input:{project_id:string;closure_id:string;operation_id?:string}):Promise<unknown>;readProjectSnapshot(input:{project_id:string}):Promise<TaskProjectSource>;readPriorityEvidence(input:{project_id:string;task_id:string}):Promise<TaskPriorityEvidence|null>; executeCommand(envelope:unknown):Promise<unknown>;query(envelope:unknown):Promise<unknown>;readEffectEvidence(input:{project_id:string;effect_id:string;dispatch_id:string}):Promise<TaskEffectEvidence|null>; recoverConfirmedEffect(input:ConfirmedEffectRecovery):Promise<unknown> }
export interface CommittedLeaseRelease {project_id:string;effect_id:string;dispatch_id:string;commit_operation_id:string;commit_operation_signature:string;operation_id:string}
export interface ConfirmedEffectRecovery {project_id:string;effect_id:string;dispatch_id:string;operation_id:string;proof_ref:ArtifactRef;lease_ms:number}
export interface TaskArtifactValidationContext {authority_source:TaskProjectSource}
export interface TaskAuthorityConfiguration {
  bindHost?: (port:TaskAuthorityHostPort)=>void;
  transport?: TaskAuthorityServerConfiguration;
  protocol: 'task-authority-config/v1'; mode: 'authority'; vault_scope: string; authority_id: string; issuer_id: string; host_id: string;
  max_lease_ms: number; eligible_project_ids: string[];
  selection_timeout_ms:number;
  selectionValidator(request:TaskAcquisitionSelectionRequest):Promise<TaskAcquisitionSelectionDecision>;
  cancel_dispatched_timeout_ms?:number;
  cancelDispatchedValidator?(request:DispatchCancellationRequest):Promise<DispatchCancellationProof>;
  progress_timeout_ms?:number;
  progressValidator?(request:TaskProgressValidationRequest):Promise<TaskProgressAuthorization>;
  closure_timeout_ms?:number;
  closureValidator?(request:ClosureValidationRequest):Promise<ClosureAuthorization>;
  capabilityValidator(envelope: Obj, effect?: AuthorityEffect): Promise<AuthorityAuthorization>;
  artifactValidator(ref: ArtifactRef, kind: 'proposal' | 'receipt' | 'evidence' | 'recovery', envelope: Obj, effect?: AuthorityEffect, validationContext?:TaskArtifactValidationContext): Promise<boolean>;
}
const errors: AuthorityError[] = ['authority_unavailable','revision_conflict','lease_busy','stale_epoch','fence_rejected','operation_signature_conflict','effect_indeterminate','capability_revoked','protocol_incompatible','invalid_command','unauthorized'];
function fail(error: AuthorityError): never { throw new Error(error); }
function copy<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T; }
function errorCode(error: unknown): AuthorityError { return error instanceof Error && errors.includes(error.message as AuthorityError) ? error.message as AuthorityError : 'invalid_command'; }
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const parse = (r: string): string[] | null => /^(file|folder|repository_file|repository_directory):([^:]+):(.+)$/.exec(r);
  const x = parse(a), y = parse(b); if (!x || !y || x[2] !== y[2]) return false;
  if (x[1].startsWith('repository_') !== y[1].startsWith('repository_')) return false;
  return ((x[1] === 'folder' || x[1] === 'repository_directory') && (y[3] === x[3] || y[3].startsWith(x[3] + '/'))) || ((y[1] === 'folder' || y[1] === 'repository_directory') && (x[3] === y[3] || x[3].startsWith(y[3] + '/')));
}
function validateConfig(value: unknown): TaskAuthorityConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_command');
  const c = value as Obj;
  const required = ['protocol','mode','vault_scope','authority_id','issuer_id','host_id','max_lease_ms','eligible_project_ids','selection_timeout_ms','selectionValidator','capabilityValidator','artifactValidator'];
  if (Object.keys(c).some(key => !required.includes(key) && !['transport','bindHost','closure_timeout_ms','closureValidator','progress_timeout_ms','progressValidator','cancel_dispatched_timeout_ms','cancelDispatchedValidator'].includes(key)) || required.some(key => !(key in c)) || c.protocol !== 'task-authority-config/v1' || c.mode !== 'authority') fail('invalid_command');
  for (const key of ['vault_scope','authority_id','issuer_id','host_id']) if (typeof c[key] !== 'string' || !(c[key]).trim()) fail('invalid_command');
  if (!Number.isSafeInteger(c.max_lease_ms) || (c.max_lease_ms as number) <= 0 || !Array.isArray(c.eligible_project_ids) || c.eligible_project_ids.some(id => typeof id !== 'string' || !id.trim()) || typeof c.capabilityValidator !== 'function' || typeof c.artifactValidator !== 'function') fail('invalid_command');
  if(c.host_id===c.issuer_id)fail('invalid_command');
  if(typeof c.selectionValidator!=='function'||!Number.isSafeInteger(c.selection_timeout_ms)||(c.selection_timeout_ms as number)<=0||(c.selection_timeout_ms as number)>2147483647)fail('invalid_command');
  if(c.progressValidator!==undefined||c.progress_timeout_ms!==undefined)if(typeof c.progressValidator!=='function'||!Number.isSafeInteger(c.progress_timeout_ms)||(c.progress_timeout_ms as number)<=0||(c.progress_timeout_ms as number)>2147483647)fail('invalid_command');
  if(c.closureValidator!==undefined||c.closure_timeout_ms!==undefined)if(typeof c.closureValidator!=='function'||!Number.isSafeInteger(c.closure_timeout_ms)||(c.closure_timeout_ms as number)<=0||(c.closure_timeout_ms as number)>2147483647)fail('invalid_command');
  if(c.cancelDispatchedValidator!==undefined||c.cancel_dispatched_timeout_ms!==undefined)if(typeof c.cancelDispatchedValidator!=='function'||!Number.isSafeInteger(c.cancel_dispatched_timeout_ms)||(c.cancel_dispatched_timeout_ms as number)<=0||(c.cancel_dispatched_timeout_ms as number)>2147483647)fail('invalid_command');
  if(c.bindHost!==undefined&&typeof c.bindHost!=='function')fail('invalid_command');
  if(c.transport!==undefined)validateServerConfiguration(c.transport);
  return { ...c, eligible_project_ids: [...c.eligible_project_ids as string[]] } as unknown as TaskAuthorityConfiguration;
}
/** One shared runtime per storage object. Authentication/eligibility validators
 * are supplied only by the trusted host integration, never accepted on wire. */
export class TaskAuthorityRuntime {
  private lifecycle:Promise<void>=Promise.resolve();
  private async serializeLifecycle<T>(work:()=>Promise<T>):Promise<T> {
    const prior=this.lifecycle;let release!:()=>void;this.lifecycle=new Promise<void>(resolve=>{release=resolve;});
    await prior;try{return await work();}finally{release();}
  }
  private config: TaskAuthorityConfiguration | null = null;
  private client:TaskAuthorityHttpClient|null=null;
  private clientConfig:TaskAuthorityClientConfiguration|null=null;
  private server:TaskAuthorityHttpsServer|null=null;
  private journal: AuthorityJournal | null = null;
  private epoch = 0;
  private generation = 0;
  private suspended = true;
  private healthy = false;
  constructor(private readonly storage: IStorageAdapter) {}
  private repository(): TaskCoordinationRepository { return this.storage.taskCoordination ?? fail('protocol_incompatible'); }
  async configure(value: unknown): Promise<void> { return this.serializeLifecycle(()=>this.configureLocked(value)); }
  private async configureLocked(value: unknown): Promise<void> {
    if(value && typeof value==='object' && (value as Obj).mode==='client') {
      if(this.config)fail('protocol_incompatible');const config=validateClientConfiguration(value);
      if(this.storage.waitForQueryReady&&!await this.storage.waitForQueryReady())fail('authority_unavailable');
      const client=new TaskAuthorityHttpClient(config,this.repository().secretStore());await client.initialize();
      this.client=client;this.clientConfig=config;this.healthy=true;this.suspended=false;return;
    }
    if(this.client)fail('protocol_incompatible');
    const config = validateConfig(value);
    if (this.config && !same([this.config.vault_scope,this.config.authority_id], [config.vault_scope,config.authority_id])) fail('protocol_incompatible');
    await serializeAuthority(config.vault_scope, config.authority_id, async () => {
      this.suspended = true; this.healthy = false;await this.server?.stop();this.server=null;
      if (this.storage.waitForQueryReady && !await this.storage.waitForQueryReady()) fail('authority_unavailable');
      const repo = this.repository(); await repo.replay();
      const journal = this.journal ?? await repo.journal(config.vault_scope, config.authority_id);
      await journal.activate();
      try {
        const history = await journal.read(); repo.validateHistory(history);
        const previousEpoch = history.filter(e => e.type === 'task_authority_activated').reduce((n,e) => e.type === 'task_authority_activated' ? e.epoch : n, 0);
        const epoch = previousEpoch + 1;
        await journal.append({ type: 'task_authority_activated', protocol: 'task-authority-activation/v1', vaultScope: config.vault_scope, authorityId: config.authority_id, epoch, tokenHash: await authorityHash(uuid()) });
        this.epoch = epoch; this.generation++;this.config = config; this.journal = journal;
        await repo.replay(); this.healthy = true; this.suspended = false;
        const generation=this.generation;config.bindHost?.({releaseCommittedLease:input=>{if(generation!==this.generation)fail('unauthorized');return this.releaseCommittedLease(input,generation);},cancelDispatchedEffect:input=>{if(generation!==this.generation)fail('unauthorized');return this.cancelDispatchedEffect(input);},readProgressConsumption:input=>{if(generation!==this.generation)fail('unauthorized');return this.readProgressConsumption(input);},closureCommand:envelope=>{if(generation!==this.generation)fail('unauthorized');return this.executeClosureCommand(envelope);},readClosure:input=>{if(generation!==this.generation)fail('unauthorized');return this.readClosure(input);},readProjectSnapshot:input=>{if(generation!==this.generation)fail('unauthorized');return this.readProjectSnapshot(input);},readPriorityEvidence:input=>this.readPriorityEvidence(input),executeCommand:envelope=>{if(generation!==this.generation)fail('unauthorized');return this.executeCommand(envelope,config.host_id);},query:envelope=>{if(generation!==this.generation)fail('unauthorized');return this.query(envelope,config.host_id);},readEffectEvidence:input=>this.readEffectEvidence(input),recoverConfirmedEffect:input=>{if(generation!==this.generation)fail('unauthorized');return this.recoverConfirmedEffect(input);}});
        if(config.transport){const server=new TaskAuthorityHttpsServer(validateServerConfiguration(config.transport),repo.secretStore(),this);await server.start();this.server=server;}
      } catch (error) { this.suspended=true;this.healthy=false;this.journal = journal; throw error; }
    });
  }
  async suspend(): Promise<{state: 'suspended'; pending_operation_ids: string[]}> {
    this.suspended = true;
    await this.server?.stop();this.server=null;
    if(this.client){const pending=this.client.pendingEnvelope();return {state:'suspended',pending_operation_ids:pending?[String(pending.operation_id)]:[]};}
    const config = this.config;
    const collect = async () => ({ state: 'suspended' as const, pending_operation_ids: (await this.repository().allStates()).flatMap(state => Object.values(state.effects).filter(effect => ['dispatched','started','indeterminate'].includes(effect.state)).map(effect => effect.operationId)) });
    return config ? serializeAuthority(config.vault_scope, config.authority_id, collect) : { state: 'suspended', pending_operation_ids: [] };
  }
  /** Lifecycle cleanup does not resolve any pending external effect. */
  async close(): Promise<void> { return this.serializeLifecycle(async()=>{ await this.suspend(); const config = this.config; if (config && this.journal) await serializeAuthority(config.vault_scope, config.authority_id, () => this.journal!.deactivate()); this.healthy = false; }); }
  async isAdmitted(projectId: string): Promise<boolean> { if (this.storage.waitForQueryReady && !await this.storage.waitForQueryReady()) fail('authority_unavailable'); await this.repository().replay();if(this.client&&this.clientConfig){const c=this.clientConfig;const status=await this.client.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:projectId,issuer_id:c.issuer_id}) as {admitted:boolean};if(!status.admitted&&await this.repository().isAdmitted(projectId))fail('fence_rejected');return status.admitted;} if(this.config)await this.repository().assertProjectScope(projectId,this.config.vault_scope,this.config.authority_id); return this.repository().isAdmitted(projectId); }
  private async scopedState(projectId:string,c:TaskAuthorityConfiguration):Promise<AuthorityProjectState|null> {
    const repo=this.repository();await repo.assertProjectScope(projectId,c.vault_scope,c.authority_id);return repo.getState(projectId);
  }
  private async scopedReceipt(projectId:string,issuerId:string,operationId:string,c:TaskAuthorityConfiguration):Promise<AuthorityReceipt|null> {
    const repo=this.repository();await repo.assertProjectScope(projectId,c.vault_scope,c.authority_id);return repo.getReceipt(projectId,issuerId,operationId);
  }
  private serializeCurrent<T>(c:TaskAuthorityConfiguration,work:()=>Promise<T>):Promise<T> {
    const generation=this.generation;return serializeAuthority(c.vault_scope,c.authority_id,async()=>{if(generation!==this.generation||this.config!==c||!this.healthy)fail('authority_unavailable');return work();});
  }
  private scope(envelope: Obj, query = false, authenticatedIssuer?: string): TaskAuthorityConfiguration {
    const c = this.config; if (!c || !this.healthy || !this.journal) fail('authority_unavailable');
    if (envelope.vault_scope !== c.vault_scope || envelope.authority_id !== c.authority_id) fail('unauthorized');
    const command = envelope.command as Obj | undefined;
    const hostOnly = command && ['beginEffect','recordEffect'].includes(String(command.type));
    const issuer = authenticatedIssuer ?? c.issuer_id;
    if (envelope.issuer_id !== issuer || (!query && hostOnly && issuer !== c.host_id)) fail('unauthorized');
    return c;
  }
  async query(value: unknown, authenticatedIssuer?: string): Promise<unknown> {
    const e = normalizeQuery(value);if(this.client)return this.client.query(e); const c = this.scope(e, true, authenticatedIssuer);
    return this.serializeCurrent(c, async () => {
      await this.repository().replay(); const state = await this.scopedState(e.project_id as string,c);
      if (e.type === 'getOperation') { const receipt = await this.scopedReceipt(e.project_id as string,e.issuer_id as string,e.operation_id as string,c); const result = receipt?.result ?? null; return { state: receipt?.error ? 'rejected' : result ? result.status === 'admitted' || result.status === 'acquired' || result.status === 'renewed' || result.status === 'released' ? 'committed' : result.status === 'confirmed' ? 'confirmed' : result.status === 'started' ? 'started' : result.status === 'dispatched' ? 'dispatched' : result.status : 'not_found', revision: state?.revision ?? 0, result, error: receipt?.error ?? null }; }
      const resources = state ? this.resourceView(state) : [];
      return { admitted: state?.admitted ?? false, revision: state?.revision ?? 0, epoch: this.epoch, resources };
    });
  }
  async readProjectSnapshot(input:{project_id:string}):Promise<TaskProjectSource> {
    const c=this.config;if(!c||!this.healthy||this.client||typeof input?.project_id!=='string'||!input.project_id)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{
      await this.journal!.assertActive();await this.repository().replay();
      const state=await this.scopedState(input.project_id,c);if(!state?.admitted)fail('protocol_incompatible');
      const rows=await this.repository().operationalSource(input.project_id) as Record<string,unknown>[][];
      const digest=await authorityHash(rows);if(digest!==state.operationalHash||rows[0]?.length!==1)fail('fence_rejected');
      return copy({protocol:'task-project-source/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,revision:state.revision,operational_hash:digest,complete:true,project:rows[0][0],tasks:rows[1],dependencies:rows[2],note_links:rows[3],external_children:rows[4]??[]});
    });
  }
  private resourceView(state: AuthorityProjectState): unknown[] {
    const map = new Map<string, unknown>();
    for (const lease of Object.values(state.leases)) for (const resource of lease.resources) { const effect = Object.values(state.effects).find(e => e.leaseId === lease.id && ['dispatched','started','confirmed','indeterminate'].includes(e.state)); const live = lease.epoch === this.epoch && lease.expiresAt > Date.now(); map.set(resource, {resource_id: resource,state: effect ? effect.state === 'indeterminate' ? 'indeterminate' : 'effect_pending' : live ? 'leased' : 'free',lease_id: effect || live ? lease.id : null,expires_at: effect || live ? new Date(lease.expiresAt).toISOString() : null,effect_id: effect?.id ?? null}); }
    return [...map.values()];
  }
  /** Called only inside serializeAuthority; no public lock-taking port is used. */
  private async selectionProjects(c:TaskAuthorityConfiguration):Promise<TaskAcquisitionSelectionProject[]> {
    const projects:TaskAcquisitionSelectionProject[]=[];
    for(const {project_id,state} of await this.repository().scopedStates(c.vault_scope,c.authority_id)) {
      if(!state.admitted)continue;
      const rows=await this.repository().operationalSource(project_id) as Record<string,unknown>[][];
      const digest=await authorityHash(rows);if(digest!==state.operationalHash||rows[0]?.length!==1||!Array.isArray(rows[1]))fail('fence_rejected');
      const source:TaskProjectSource={protocol:'task-project-source/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id,revision:state.revision,operational_hash:digest,complete:true,project:rows[0][0],tasks:rows[1],dependencies:rows[2],note_links:rows[3],external_children:rows[4]??[]};
      const priority_evidence:Array<{task_id:string;evidence:TaskPriorityEvidence|null}>=[];
      for(const task of [...source.tasks].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0)) {
        if(typeof task.id!=='string'||!task.id)fail('fence_rejected');
        priority_evidence.push({task_id:task.id,evidence:await this.repository().readPriorityEvidence(project_id,task.id,c.vault_scope,c.authority_id)});
      }
      projects.push({source,coordination:{admitted:true,revision:state.revision,epoch:this.epoch,resources:this.resourceView(state) as TaskAcquisitionSelectionProject['coordination']['resources']},priority_evidence});
    }
    return projects.sort((a,b)=>a.source.project_id<b.source.project_id?-1:a.source.project_id>b.source.project_id?1:0);
  }
  private async selectForAcquisition(c:TaskAuthorityConfiguration,e:Obj):Promise<TaskAcquisitionSelectionProject[]> {
    const cmd=e.command as Obj,projects=await this.selectionProjects(c);
    const context={protocol:'task-acquire-selection/v1' as const,vault_scope:c.vault_scope,authority_id:c.authority_id,epoch:this.epoch,now_ms:Date.now(),requested:{project_id:String(e.project_id),task_id:String(cmd.task_id),capability_ref:copy(cmd.capability_ref) as TaskAcquisitionSelectionRequest['requested']['capability_ref'],resources:copy(cmd.resources) as string[]},projects};
    const snapshot_hash=await authorityHash(context),request={...context,snapshot_hash};
    let timer:ReturnType<typeof setTimeout>|undefined;let decision:unknown;
    try { decision=await Promise.race([Promise.resolve().then(()=>c.selectionValidator(copy(request))),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fence_rejected')),c.selection_timeout_ms);})]); }
    catch {fail('fence_rejected');}finally{if(timer)clearTimeout(timer);}
    const closed=(v:unknown,keys:string[]):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
    if(!closed(decision,['protocol','snapshot_hash','selection'])||decision.protocol!=='task-acquire-selection-decision/v1'||decision.snapshot_hash!==snapshot_hash)fail('fence_rejected');
    const selection=decision.selection;
    if(!closed(selection,['protocol','state','selected_unit','reason_refs','source_revisions'])||selection.protocol!=='dream-priority-selection/v1'||selection.state!=='selected'||!Array.isArray(selection.reason_refs)||selection.reason_refs.length||!same(selection.source_revisions,projects.map(p=>({project_id:p.source.project_id,revision:p.source.revision}))))fail('fence_rejected');
    const unit=selection.selected_unit;
    if(!closed(unit,['project_id','task_id'])||unit.project_id!==e.project_id||unit.task_id!==cmd.task_id)fail('fence_rejected');
    return projects;
  }
  private async readProgressConsumption(input:{project_id:string;effect_id:string;dispatch_id:string}):Promise<TaskProgressConsumptionReadback|null>{
    if(!input||Object.keys(input).sort().join(',')!=='dispatch_id,effect_id,project_id'||Object.values(input).some(v=>typeof v!=='string'||!v))fail('invalid_command');const c=this.config;if(!c||this.client)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{const repo=this.repository();await repo.replay();const state=await this.scopedState(input.project_id,c),effect=state&&Object.prototype.hasOwnProperty.call(state.effects,input.effect_id)?state.effects[input.effect_id]:undefined;if(!effect)return null;if(effect.dispatchId!==input.dispatch_id)fail('fence_rejected');if(effect.state!=='committed'||!effect.progressConsumption||!effect.receiptRef||!effect.recordOperationId||!effect.recordOperationSignature)return null;return copy({protocol:'task-progress-consumption/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,effect_id:effect.id,dispatch_id:effect.dispatchId,state:'committed',binding:effect.progressConsumption,producer_receipt_ref:effect.receiptRef,record_operation_id:effect.recordOperationId,record_operation_signature:effect.recordOperationSignature,revision:effect.lastRevision});});
  }
  private async readClosure(input:{project_id:string;closure_id:string;operation_id?:string}):Promise<unknown>{
    if(!input||Object.keys(input).some(k=>!['project_id','closure_id','operation_id'].includes(k))||typeof input.project_id!=='string'||!input.project_id||typeof input.closure_id!=='string'||!input.closure_id||(input.operation_id!==undefined&&(typeof input.operation_id!=='string'||!input.operation_id)))fail('invalid_command');
    const c=this.config;if(!c||this.client)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{await this.repository().replay();const state=await this.scopedState(input.project_id,c);if(!state?.admitted)fail('protocol_incompatible');return copy({protocol:'task-closure-state/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,closure_id:input.closure_id,revision:state.revision,epoch:this.epoch,closure:closureRecord(state,input.closure_id),effects:Object.values(state.effects).filter(effect=>effect.subject?.closure_id===input.closure_id),operation:input.operation_id?await this.scopedReceipt(input.project_id,c.host_id,input.operation_id,c):null});});
  }
  private async executeClosureCommand(value:unknown):Promise<unknown>{
    const e=normalizeClosureCommand(value),c=this.scope(e as unknown as Obj,false,this.config?.host_id);if(!c.closureValidator||!c.closure_timeout_ms)fail('protocol_incompatible');
    return this.serializeCurrent(c,async()=>{
      if((this.suspended&&e.command.type!=='commitClosureStep')||!this.healthy)fail('authority_unavailable');const repo=this.repository();await this.journal!.assertActive();await repo.replay();
      const signature=await authorityHash(e),old=await this.scopedReceipt(e.project_id,c.host_id,e.operation_id,c);if(old){if(old.signature!==signature)fail('operation_signature_conflict');if(old.error)fail(old.error);return old.result;}
      const previous=await this.scopedState(e.project_id,c);if(!previous?.admitted)fail('protocol_incompatible');let state=copy(previous),delta:OperationalTaskEvent[]=[],result:CommandResult|null=null,error:AuthorityError|null=null;
      try{
        if(e.expected_revision!==state.revision)fail('revision_conflict');
        const outcome=await new TaskAuthorityClosureService(repo,c,this.epoch).reduce(e,state,{
          busy:async(resources,ownLease)=>{for(const other of await repo.allStates())for(const lease of Object.values(other.leases)){if(lease.id===ownLease)continue;const pending=Object.values(other.effects).some(effect=>effect.leaseId===lease.id&&['dispatched','started','confirmed','indeterminate'].includes(effect.state));if((pending||lease.expiresAt>Date.now())&&resources.some(a=>lease.resources.some(b=>overlaps(a,b))))return true;}return false;},
          authorize:async effect=>{let auth:AuthorityAuthorization;try{auth=await finiteClosure(()=>c.capabilityValidator(e as unknown as Obj,effect),c.closure_timeout_ms);}catch{fail('capability_revoked');}if(!auth||!Number.isSafeInteger(auth.max_lease_ms)||auth.max_lease_ms<=0)fail('capability_revoked');normalizeResourceList(auth.resources);return auth;},
          artifact:async(ref,kind,effect)=>{let valid=false;try{valid=await finiteClosure(()=>c.artifactValidator(ref,kind,e as unknown as Obj,effect),c.closure_timeout_ms);}catch{/* refuse */}if(!valid)fail('fence_rejected');}
        });
        if(await repo.currentHash(e.project_id)!==previous.operationalHash)fail('fence_rejected');if(e.command.type!=='acquireClosure'){const lease=state.leases[String(e.command.lease_id)];if(!lease||lease.expiresAt<=Date.now()||lease.epoch!==this.epoch)fail('stale_epoch');}state.revision++;delta=outcome.delta;result={vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:e.project_id,issuer_id:c.host_id,operation_id:e.operation_id,revision:state.revision,...outcome.result} as CommandResult;
      }catch(caught){error=errorCode(caught);state=copy(previous);delta=[];}
      const receipt:AuthorityReceipt={signature,revision:state.revision,result,error};const event:CoordinationCommittedEvent={id:uuid(),deviceId:'task-authority',timestamp:Date.now(),type:'project_coordination_committed',protocol:'task-coordination-event/v1',vaultScope:c.vault_scope,authorityId:c.authority_id,projectId:e.project_id,previousRevision:previous.revision,revision:state.revision,operationKey:JSON.stringify([c.host_id,e.operation_id]),signature,issuerId:c.host_id,operationId:e.operation_id,state,receipt,delta};
      try{await this.journal!.append(event);await repo.apply(event);}catch{this.healthy=false;this.suspended=true;fail('authority_unavailable');}if(error)fail(error);return result;
    });
  }
  async executeCommand(value: unknown, authenticatedIssuer?: string): Promise<unknown> {
    const e = normalizeCommand(value);if(this.client){if(this.suspended&&['admitProject','acquireUnit','renewLease','dispatchEffect','beginEffect','interactiveMutation'].includes(String((e.command as Obj).type)))fail('authority_unavailable');return this.client.executeCommand(e);} const c = this.scope(e, false, authenticatedIssuer);
    return this.serializeCurrent(c, async () => {
      const repo = this.repository();
      try { await this.journal!.assertActive(); await repo.replay(); } catch { this.healthy = false; fail('authority_unavailable'); }
      const signature = await authorityHash(e); const projectId = e.project_id as string; const issuer = e.issuer_id as string; const operation = e.operation_id as string;
      const old = await this.scopedReceipt(projectId,issuer,operation,c);
      if (old) { if (old.signature !== signature) fail('operation_signature_conflict'); if (old.error) fail(old.error); return old.result; }
      const previous = await this.scopedState(projectId,c); const base = previous ?? {admitted:false, revision:0,epoch:this.epoch,baselineHash:await repo.currentHash(projectId),operationalHash:await repo.currentHash(projectId),leases:{},effects:{}};
      let state = copy(base); let delta: OperationalTaskEvent[] = []; let priorityAssignment:PriorityAssignment|undefined; let result: CommandResult | null = null; let error: AuthorityError | null = null;
      try {
        if (e.expected_revision !== base.revision) fail('revision_conflict');
        const command = e.command as Obj;
        if (this.suspended && ['admitProject','acquireUnit','renewLease','dispatchEffect','beginEffect','interactiveMutation'].includes(String(command.type))) fail('authority_unavailable');
        const outcome = await this.reduce(c,e,state);
        state = outcome.state; delta = outcome.delta; priorityAssignment = outcome.priorityAssignment;
        state.revision = base.revision + 1;
        result = {vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:projectId,issuer_id:issuer,operation_id:operation,revision:state.revision,...outcome.result} as CommandResult;
      } catch (caught) { error = errorCode(caught); state = copy(base); delta = []; }
      const receipt: AuthorityReceipt = {...(priorityAssignment?{priorityAssignment}:{}),signature,revision:state.revision,result,error};
      const event: CoordinationCommittedEvent = {id:uuid(),deviceId:'task-authority',timestamp:Date.now(),type:'project_coordination_committed',protocol:'task-coordination-event/v1',vaultScope:c.vault_scope,authorityId:c.authority_id,projectId,previousRevision:base.revision,revision:state.revision,operationKey:JSON.stringify([issuer,operation]),signature,issuerId:issuer,operationId:operation,state,receipt,delta};
      try { await this.journal!.append(event); await repo.apply(event); }
      catch { this.healthy = false; this.suspended = true; fail('authority_unavailable'); }
      if (error) fail(error); return result;
    });
  }
  private async reduce(c: TaskAuthorityConfiguration, e: Obj, state: AuthorityProjectState): Promise<{state: AuthorityProjectState; delta: OperationalTaskEvent[]; result: Obj;priorityAssignment?: PriorityAssignment}> {
    const cmd = e.command as Obj; const project = e.project_id as string; const issuer = e.issuer_id as string; const now = Date.now();
    let priorityAssignment:PriorityAssignment|undefined; let delta: OperationalTaskEvent[] = []; let result: Obj;
    if (cmd.type === 'admitProject') {
      await this.repository().requireActiveProject(project);
      if (state.admitted || !c.eligible_project_ids.includes(project) || cmd.baseline_hash !== await this.repository().currentHash(project)) fail('fence_rejected');
      state.admitted = true; state.epoch = this.epoch; state.baselineHash = cmd.baseline_hash; state.operationalHash = state.baselineHash;
      result = {status:'admitted',epoch:this.epoch,baseline_hash:state.baselineHash}; return {state,delta,result};
    }
    if (!state.admitted) fail('protocol_incompatible');
    const pending = (effect: AuthorityEffect): boolean => ['dispatched','started','confirmed','indeterminate'].includes(effect.state);
    const requireLease = (allowExpired = false): AuthorityLease => { const lease = state.leases[String(cmd.lease_id)]; if (!lease || lease.issuer !== issuer || lease.epoch !== cmd.epoch || cmd.epoch !== this.epoch) fail('stale_epoch'); if (!allowExpired && lease.expiresAt <= now) fail('stale_epoch'); return lease; };
    const busy = async (resources: string[], ownLease?: string): Promise<boolean> => {
      for (const other of await this.repository().allStates()) for (const lease of Object.values(other.leases)) {
        if (lease.id === ownLease) continue;
        const inflight = Object.values(other.effects).some(effect => effect.leaseId === lease.id && pending(effect));
        if ((inflight || lease.expiresAt > now) && resources.some(a => lease.resources.some(b => overlaps(a,b)))) return true;
      }
      return false;
    };
    const authorization = async (effect?: AuthorityEffect): Promise<AuthorityAuthorization> => {
      let auth: AuthorityAuthorization; try { auth = await (effect?.subject?finiteClosure(()=>c.capabilityValidator(e,effect),c.closure_timeout_ms):c.capabilityValidator(e,effect)); } catch { fail('capability_revoked'); }
      if (!auth || !Array.isArray(auth.resources) || !Number.isSafeInteger(auth.max_lease_ms) || auth.max_lease_ms <= 0 || auth.resources.some(r => typeof r !== 'string')) fail('capability_revoked');
      try { normalizeResourceList(auth.resources); } catch { fail('capability_revoked'); }
      return auth;
    };
    let validationContext:TaskArtifactValidationContext|undefined;
    const artifact = async (ref: unknown, kind: 'proposal'|'receipt'|'evidence', effect?:AuthorityEffect): Promise<void> => { let valid=false; try {const context=validationContext?copy(validationContext):undefined;valid=await (effect?.subject?finiteClosure(()=>c.artifactValidator(ref as ArtifactRef,kind,e,effect,context),c.closure_timeout_ms):c.artifactValidator(ref as ArtifactRef,kind,e,effect,context));} catch { /* refuse */ } if (!valid) fail('fence_rejected'); };
    if (cmd.type === 'interactiveMutation') {
      const mutation = cmd.mutation as InteractiveMutation;
      const derived = [`project:${project}`]; const task = mutation.arguments.taskId; if (typeof task === 'string') derived.push(`task:${task}`);
      if (typeof mutation.arguments.parentTaskId === 'string') derived.push(`task:${mutation.arguments.parentTaskId}`);
      for (const id of (mutation.arguments.dependsOn ?? []) as string[]) derived.push(`task:${id}`);
      for (const id of (mutation.arguments.addDependencies ?? []) as string[]) derived.push(`task:${id}`);
      for (const id of (mutation.arguments.removeDependencies ?? []) as string[]) derived.push(`task:${id}`);
      const resources = [...new Set(derived)].sort();
      if (!same(resources,cmd.resources)) fail('fence_rejected');
      if (await busy(resources)) fail('lease_busy');
      const explicitPriority=mutation.arguments.priority;
      const decisionRef='task-authority-decision/v1/'+[c.vault_scope,c.authority_id,project,issuer,String(e.operation_id)].map(encodeURIComponent).join('/');
      const provenance=typeof explicitPriority==='string'?{value:explicitPriority,decision_ref:decisionRef,source_operation_id:String(e.operation_id)}:undefined;
      const prepared = await this.repository().prepare(project,mutation,provenance);
      if(provenance)priorityAssignment={taskId:prepared.entityId,value:provenance.value,decisionRef}; delta = prepared.delta; state.operationalHash = prepared.operationalHash;
      result = {status:'committed',kind:mutation.kind,entity_id:prepared.entityId};
    } else if (cmd.type === 'acquireUnit') {
      await this.repository().validateEligibility(project,String(cmd.task_id),c.vault_scope,c.authority_id);
      if(await busy(cmd.resources as string[]))fail('lease_busy');
      const selectedProjects=await this.selectForAcquisition(c,e);
      const auth = await authorization(); const required = [`project:${project}`,`task:${String(cmd.task_id)}`];
      if (!same(auth.resources,cmd.resources) || required.some(r => !auth.resources.includes(r)) || (cmd.lease_ms as number) > Math.min(c.max_lease_ms,auth.max_lease_ms)) fail('fence_rejected');
      if (await busy(auth.resources)) fail('lease_busy');
      if(!same(selectedProjects,await this.selectionProjects(c)))fail('fence_rejected');
      const lease: AuthorityLease = {id:uuid(),issuer,epoch:this.epoch,taskId:String(cmd.task_id),expiresAt:Date.now()+(cmd.lease_ms as number),maxLeaseMs:Math.min(c.max_lease_ms,auth.max_lease_ms),resources:[...auth.resources]}; state.leases[lease.id] = lease; state.epoch=this.epoch;
      result={status:'acquired',epoch:this.epoch,lease_id:lease.id,expires_at:new Date(lease.expiresAt).toISOString(),resources:lease.resources};
    } else if (cmd.type === 'renewLease') {
      const lease = requireLease(); if ((cmd.lease_ms as number) > Math.min(c.max_lease_ms,lease.maxLeaseMs)) fail('fence_rejected'); lease.expiresAt = now+(cmd.lease_ms as number);
      result={status:'renewed',epoch:this.epoch,lease_id:lease.id,expires_at:new Date(lease.expiresAt).toISOString()};
    } else if (cmd.type === 'releaseLease') {
      const lease = requireLease(); if (Object.values(state.effects).some(effect => effect.leaseId === lease.id && pending(effect))) fail('effect_indeterminate'); delete state.leases[lease.id]; result={status:'released'};
    } else if (cmd.type === 'dispatchEffect') {
      const lease = requireLease(); const auth=await authorization();
      if ((await this.repository().allStates()).some(other=>Object.prototype.hasOwnProperty.call(other.effects,String(cmd.effect_id)))) fail('fence_rejected');
      if (!same(lease.resources,cmd.resources) || !same(auth.resources,cmd.resources) || Object.values(state.effects).some(effect => effect.leaseId===lease.id && pending(effect)) || (Object.prototype.hasOwnProperty.call(state.effects,String(cmd.effect_id)) ? state.effects[String(cmd.effect_id)] : undefined)) fail('fence_rejected');
      const effect: AuthorityEffect={id:String(cmd.effect_id),operationId:String(e.operation_id),dispatchId:uuid(),leaseId:lease.id,issuer,hostId:c.host_id,proposalHash:String(cmd.proposal_hash),preconditionHash:String(cmd.precondition_hash),capabilityRef:cmd.capability_ref,proposalRef:cmd.proposal_ref,lastRevision:state.revision+1,resources:lease.resources,state:'dispatched'}; state.effects={...state.effects,[effect.id]:effect};
      if(lease.subject){effect.subject=copy(lease.subject);await new TaskAuthorityClosureService(this.repository(),c,this.epoch).validate('dispatchEffect',e,state,lease.subject,effect);}
      await artifact(cmd.proposal_ref,'proposal',effect);
      if(this.suspended)fail('authority_unavailable');if(lease.epoch!==this.epoch||lease.expiresAt<=Date.now())fail('stale_epoch');
      result={status:'dispatched',epoch:this.epoch,effect_id:effect.id,dispatch_id:effect.dispatchId};
    } else if (cmd.type === 'beginEffect') {
      const effect=(Object.prototype.hasOwnProperty.call(state.effects,String(cmd.effect_id)) ? state.effects[String(cmd.effect_id)] : undefined); const lease=state.leases[String(cmd.lease_id)];
      if (!effect || !lease || effect.dispatchId!==cmd.dispatch_id || effect.leaseId!==lease.id || effect.hostId!==issuer || cmd.host_id!==issuer || cmd.epoch!==this.epoch || lease.epoch!==this.epoch || lease.expiresAt<=now || effect.state!=='dispatched' || effect.proposalHash!==cmd.proposal_hash) fail('fence_rejected');
      await authorization(effect); await artifact(effect.proposalRef,'proposal',effect);
      if(effect.subject)await new TaskAuthorityClosureService(this.repository(),c,this.epoch).validate('beginEffect',e,state,effect.subject,effect);
      if(this.suspended)fail('authority_unavailable');if(lease.epoch!==this.epoch||lease.expiresAt<=Date.now())fail('stale_epoch');
      effect.state='started';effect.lastRevision=state.revision+1; result={status:'started',dispatch_id:effect.dispatchId,effect_id:effect.id};
    } else if (cmd.type === 'recordEffect') {
      const effect=(Object.prototype.hasOwnProperty.call(state.effects,String(cmd.effect_id)) ? state.effects[String(cmd.effect_id)] : undefined); if (!effect || effect.dispatchId!==cmd.dispatch_id || effect.hostId!==issuer || !['started','indeterminate'].includes(effect.state)) fail('fence_rejected');
      await artifact(cmd.receipt_ref,'receipt',effect); if ((cmd.receipt_ref as ArtifactRef).hash!==cmd.receipt_hash) fail('fence_rejected');
      effect.state=cmd.result==='applied'?'confirmed':cmd.result==='base_conflict'?'rejected':cmd.result==='failed'?'failed':'indeterminate'; effect.receiptRef=cmd.receipt_ref as ArtifactRef;effect.recordOperationId=String(e.operation_id);effect.recordOperationSignature=await authorityHash(e);effect.recordRevision=state.revision+1;effect.lastRevision=state.revision+1;
      result={status:effect.state,effect_id:effect.id};
    } else if (cmd.type === 'commitProgress') {
      const lease=requireLease(); const effect=(Object.prototype.hasOwnProperty.call(state.effects,String(cmd.effect_id)) ? state.effects[String(cmd.effect_id)] : undefined);
      if (!effect || effect.subject || lease.subject || effect.state!=='confirmed' || effect.leaseId!==lease.id || lease.taskId!==cmd.task_id || !same(effect.receiptRef,cmd.receipt_ref)) fail('fence_rejected');
      if(!c.progressValidator||!c.progress_timeout_ms)fail('protocol_incompatible');
      const sourceRows=await this.repository().operationalSource(project) as Obj[][];
      const sourceHash=await authorityHash(sourceRows);if(sourceHash!==state.operationalHash||sourceRows[0]?.length!==1)fail('fence_rejected');
      validationContext={authority_source:{protocol:'task-project-source/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:project,revision:state.revision,operational_hash:sourceHash,complete:true,project:sourceRows[0][0],tasks:sourceRows[1],dependencies:sourceRows[2],note_links:sourceRows[3],external_children:sourceRows[4]??[]}};
      await artifact(cmd.receipt_ref,'receipt',effect); for (const ref of cmd.evidence_refs as ArtifactRef[]) await artifact(ref,'evidence');
      let consumption:TaskProgressAuthorization;try{consumption=normalizeProgressAuthorization(await finiteClosure(()=>c.progressValidator!(copy({protocol:'task-progress-validation/v1',envelope:e,source:validationContext!.authority_source,effect,transition:{task_id:String(cmd.task_id),expected_status:String(cmd.expected_status),next_status:String(cmd.next_status),receipt_ref:cmd.receipt_ref as ArtifactRef,evidence_refs:cmd.evidence_refs as ArtifactRef[]}})),c.progress_timeout_ms));}catch{fail('fence_rejected');}
      if(same(consumption.consumption_capability_ref,effect.capabilityRef))fail('capability_revoked');
      effect.progressConsumption={consumption_capability_ref:consumption.consumption_capability_ref,consumption_profile_ref:consumption.consumption_profile_ref,proof_refs:consumption.proof_refs,source_revision:state.revision,operational_hash:sourceHash,commit_operation_id:String(e.operation_id),commit_operation_signature:await authorityHash(e)};
      if(await this.repository().currentHash(project)!==sourceHash||(await this.scopedState(project,c))?.revision!==state.revision)fail('fence_rejected');
      await this.repository().validateEligibility(project,String(cmd.task_id),c.vault_scope,c.authority_id); const task=await this.repository().requireTask(project,String(cmd.task_id)); if (task.status!==cmd.expected_status) fail('revision_conflict');
      const prepared=await this.repository().prepare(project,{kind:'updateTask',arguments:{taskId:cmd.task_id,status:cmd.next_status,metadata:{dream_effect_receipt_v1:{effect_id:effect.id,receipt_ref:cmd.receipt_ref,evidence_refs:cmd.evidence_refs}}}});
      if(lease.expiresAt<=Date.now()||lease.epoch!==this.epoch)fail('stale_epoch');
      delta=prepared.delta; state.operationalHash=prepared.operationalHash; effect.state='committed';effect.lastRevision=state.revision+1; result={status:'committed',effect_id:effect.id,task_id:cmd.task_id,receipt_ref:cmd.receipt_ref};
    } else fail('protocol_incompatible');
    return {state,delta,result,priorityAssignment};
  }
  /** Release only the historical lease bound to a durably consumed effect. */
  private async releaseCommittedLease(input:CommittedLeaseRelease,generation:number):Promise<unknown>{
    const keys=['commit_operation_id','commit_operation_signature','dispatch_id','effect_id','operation_id','project_id'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==keys.join(',')||keys.some(k=>typeof input[k as keyof CommittedLeaseRelease]!=='string'||!input[k as keyof CommittedLeaseRelease].trim())||!/^[a-f0-9]{64}$/.test(input.commit_operation_signature))fail('invalid_command');
    const c=this.config;if(!c||!this.healthy||!this.journal)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{
      if(generation!==this.generation)fail('unauthorized');
      const repo=this.repository();await this.journal!.assertActive();await repo.replay();
      const signature=await authorityHash({protocol:'task-committed-lease-release/v1',...input,vault_scope:c.vault_scope,authority_id:c.authority_id,host_id:c.host_id});
      const old=await this.scopedReceipt(input.project_id,c.host_id,input.operation_id,c);if(old){if(old.signature!==signature)fail('operation_signature_conflict');if(old.error)fail(old.error);return old.result;}
      const previous=await this.scopedState(input.project_id,c);if(!previous?.admitted)fail('fence_rejected');
      const state=copy(previous),effect=Object.prototype.hasOwnProperty.call(state.effects,input.effect_id)?state.effects[input.effect_id]:undefined;
      if(!effect||effect.state!=='committed'||effect.dispatchId!==input.dispatch_id||effect.hostId!==c.host_id)fail('fence_rejected');
      const commit=await this.scopedReceipt(input.project_id,effect.issuer,input.commit_operation_id,c),result=commit?.result;
      if(!commit||commit.error||commit.signature!==input.commit_operation_signature||!result||result.status!=='committed'||result.project_id!==input.project_id||result.issuer_id!==effect.issuer)fail('fence_rejected');
      const lease=Object.prototype.hasOwnProperty.call(state.leases,effect.leaseId)?state.leases[effect.leaseId]:undefined;
      if(effect.subject){
        const subject=effect.subject;
        if(subject.kind!=='closure'||effect.issuer!==c.host_id||!effect.receiptRef||!('kind' in result)||result.kind!=='closure_step'||!('entity_id' in result)||result.entity_id!==subject.closure_id||commit.revision!==effect.lastRevision||result.revision!==effect.lastRevision||!closureConsumptionMatches(state,effect))fail('fence_rejected');
        if(lease&&(lease.id!==effect.leaseId||lease.issuer!==effect.issuer||lease.taskId!==undefined||!same(lease.subject,subject)||!same(lease.resources,effect.resources)))fail('fence_rejected');
      }else{
        if(!effect.progressConsumption||effect.progressConsumption.commit_operation_id!==input.commit_operation_id||effect.progressConsumption.commit_operation_signature!==input.commit_operation_signature||!('effect_id' in result)||result.effect_id!==effect.id||!('task_id' in result)||!('receipt_ref' in result)||typeof result.task_id!=='string'||!effect.resources.includes(`task:${result.task_id}`)||!same(result.receipt_ref,effect.receiptRef))fail('fence_rejected');
        if(lease&&(lease.id!==effect.leaseId||lease.issuer!==effect.issuer||lease.taskId!==result.task_id||!same(lease.resources,effect.resources)))fail('fence_rejected');
      }
      if(Object.values(state.effects).some(other=>other.id!==effect.id&&other.leaseId===effect.leaseId&&['dispatched','started','confirmed','indeterminate'].includes(other.state)))fail('effect_indeterminate');
      if(lease)delete state.leases[effect.leaseId];state.revision++;
      const released:CommandResult={vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,issuer_id:c.host_id,operation_id:input.operation_id,revision:state.revision,status:'released'};
      const receipt:AuthorityReceipt={signature,revision:state.revision,result:released,error:null};const event:CoordinationCommittedEvent={id:uuid(),deviceId:'task-authority',timestamp:Date.now(),type:'project_coordination_committed',protocol:'task-coordination-event/v1',vaultScope:c.vault_scope,authorityId:c.authority_id,projectId:input.project_id,previousRevision:previous.revision,revision:state.revision,operationKey:JSON.stringify([c.host_id,input.operation_id]),signature,issuerId:c.host_id,operationId:input.operation_id,state,receipt,delta:[]};
      try{await this.journal!.append(event);await repo.apply(event);}catch{this.healthy=false;this.suspended=true;fail('authority_unavailable');}return released;
    });
  }
  /** Never-started cancellation is internal and serialized with beginEffect.
   * It cannot settle a started/unknown applicator or fabricate a producer receipt. */
  private async cancelDispatchedEffect(input:DispatchedEffectCancellation):Promise<unknown>{
    if(!input||Object.keys(input).sort().join(',')!=='dispatch_id,effect_id,operation_id,project_id,proof_ref'||['project_id','effect_id','dispatch_id','operation_id'].some(k=>{const v=input[k as keyof DispatchedEffectCancellation];return typeof v!=='string'||!v.trim();})||!input.proof_ref||Object.keys(input.proof_ref).sort().join(',')!=='artifact_id,hash'||typeof input.proof_ref.artifact_id!=='string'||!input.proof_ref.artifact_id||!/^[a-f0-9]{64}$/.test(input.proof_ref.hash))fail('invalid_command');
    const c=this.config;if(!c||!this.healthy||!this.journal)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{
      const repo=this.repository();await this.journal!.assertActive();await repo.replay();
      const signature=await authorityHash({protocol:'task-dispatch-cancellation/v1',...input,vault_scope:c.vault_scope,authority_id:c.authority_id,host_id:c.host_id});
      const oldReceipt=await this.scopedReceipt(input.project_id,c.host_id,input.operation_id,c);if(oldReceipt){if(oldReceipt.signature!==signature)fail('operation_signature_conflict');if(oldReceipt.error)fail(oldReceipt.error);return oldReceipt.result;}
      const previous=await this.scopedState(input.project_id,c);if(!previous?.admitted)fail('fence_rejected');const state=copy(previous),effect=state.effects[input.effect_id];
      if(!effect||effect.dispatchId!==input.dispatch_id||effect.hostId!==c.host_id||effect.state!=='dispatched')fail('fence_rejected');
      if(!c.cancelDispatchedValidator||!c.cancel_dispatched_timeout_ms)fail('protocol_incompatible');
      let proof:DispatchCancellationProof;try{proof=await finiteClosure(()=>c.cancelDispatchedValidator!(copy({protocol:'task-dispatch-cancellation-validation/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,host_id:c.host_id,project_id:input.project_id,effect,proof_ref:input.proof_ref})),c.cancel_dispatched_timeout_ms);}catch{fail('fence_rejected');}
      const validRef=(v:ArtifactRef)=>v&&Object.keys(v).sort().join(',')==='artifact_id,hash'&&typeof v.artifact_id==='string'&&!!v.artifact_id&&typeof v.hash==='string'&&/^[a-f0-9]{64}$/.test(v.hash);
      if(!proof||Object.keys(proof).sort().join(',')!=='proof_ref,protocol,quiescence_ref,resources'||proof.protocol!=='task-dispatch-cancellation-proof/v1'||!same(proof.proof_ref,input.proof_ref)||!validRef(proof.quiescence_ref)||!same(proof.resources,effect.resources))fail('fence_rejected');
      effect.state='failed';effect.lastRevision=state.revision+1;effect.cancellation={proof_ref:copy(input.proof_ref),quiescence_ref:copy(proof.quiescence_ref),operation_id:input.operation_id,operation_signature:signature,revision:state.revision+1};
      if(!Object.values(state.effects).some(other=>other.id!==effect.id&&other.leaseId===effect.leaseId&&['dispatched','started','confirmed','indeterminate'].includes(other.state)))delete state.leases[effect.leaseId];
      state.revision++;const result:CommandResult={vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,issuer_id:c.host_id,operation_id:input.operation_id,revision:state.revision,status:'failed',effect_id:effect.id};
      const receipt:AuthorityReceipt={signature,revision:state.revision,result,error:null};const event:CoordinationCommittedEvent={id:uuid(),deviceId:'task-authority',timestamp:Date.now(),type:'project_coordination_committed',protocol:'task-coordination-event/v1',vaultScope:c.vault_scope,authorityId:c.authority_id,projectId:input.project_id,previousRevision:previous.revision,revision:state.revision,operationKey:JSON.stringify([c.host_id,input.operation_id]),signature,issuerId:c.host_id,operationId:input.operation_id,state,receipt,delta:[]};
      try{await this.journal!.append(event);await repo.apply(event);}catch{this.healthy=false;this.suspended=true;fail('authority_unavailable');}return result;
    });
  }
  /** Internal recovery only consumes an already confirmed effect. The host
   * validator must resolve immutable quiescence evidence, never a caller boolean.
   * An unreachable host or missing proof leaves the old resources occupied. */
  private async recoverConfirmedEffect(input:ConfirmedEffectRecovery):Promise<unknown>{
    if(!input||Object.keys(input).sort().join(',')!=='dispatch_id,effect_id,lease_ms,operation_id,project_id,proof_ref'||['project_id','effect_id','dispatch_id','operation_id'].some(k=>{const value=input[k as keyof ConfirmedEffectRecovery];return typeof value!=='string'||!value.trim();})||!Number.isSafeInteger(input.lease_ms)||input.lease_ms<=0||!input.proof_ref||Object.keys(input.proof_ref).sort().join(',')!=='artifact_id,hash'||typeof input.proof_ref.artifact_id!=='string'||!input.proof_ref.artifact_id||!/^[a-f0-9]{64}$/.test(input.proof_ref.hash))fail('invalid_command');
    const c=this.config;if(!c||!this.healthy||!this.journal)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{
      const repo=this.repository();await this.journal!.assertActive();await repo.replay();
      const signature=await authorityHash({protocol:'task-authority-confirmed-recovery/v1',...input,vault_scope:c.vault_scope,authority_id:c.authority_id,host_id:c.host_id});
      const previousReceipt=await this.scopedReceipt(input.project_id,c.host_id,input.operation_id,c);if(previousReceipt){if(previousReceipt.signature!==signature)fail('operation_signature_conflict');if(previousReceipt.error)fail(previousReceipt.error);return previousReceipt.result;}
      const previous=await this.scopedState(input.project_id,c);if(!previous?.admitted)fail('fence_rejected');const state=copy(previous);
      const effect=Object.prototype.hasOwnProperty.call(state.effects,input.effect_id)?state.effects[input.effect_id]:undefined;
      if(!effect||effect.dispatchId!==input.dispatch_id||effect.state!=='confirmed'||!effect.receiptRef||effect.hostId!==c.host_id)fail('fence_rejected');
      const oldLease=state.leases[effect.leaseId];if(!oldLease||input.lease_ms>Math.min(c.max_lease_ms,oldLease.maxLeaseMs))fail('fence_rejected');
      const envelope:Obj={protocol:'task-authority-confirmed-recovery/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,issuer_id:c.host_id,operation_id:input.operation_id,proof_ref:input.proof_ref,command:{type:'recoverConfirmedEffect',effect_id:input.effect_id,dispatch_id:input.dispatch_id}};
      let verified=false;try{verified=await c.artifactValidator(input.proof_ref,'recovery',envelope,effect)&&await c.artifactValidator(effect.receiptRef,'receipt',envelope,effect);const authorization=await c.capabilityValidator(envelope,effect);verified=verified&&same(authorization.resources,effect.resources)&&input.lease_ms<=authorization.max_lease_ms;}catch{verified=false;}if(!verified)fail('fence_rejected');
      if(oldLease.subject){if(!same(oldLease.subject,effect.subject))fail('fence_rejected');await new TaskAuthorityClosureService(repo,c,this.epoch).validate('recoverConfirmedEffect',envelope,state,oldLease.subject,effect,[input.proof_ref]);}
      else{if(typeof oldLease.taskId!=='string'||!oldLease.taskId)fail('fence_rejected');await repo.validateEligibility(input.project_id,oldLease.taskId,c.vault_scope,c.authority_id);}
      const lease:AuthorityLease={...oldLease,id:uuid(),epoch:this.epoch,expiresAt:Date.now()+input.lease_ms};delete state.leases[oldLease.id];state.leases[lease.id]=lease;effect.leaseId=lease.id;state.epoch=this.epoch;state.revision++;
      const result:CommandResult={vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,issuer_id:c.host_id,operation_id:input.operation_id,revision:state.revision,status:'acquired',epoch:this.epoch,lease_id:lease.id,expires_at:new Date(lease.expiresAt).toISOString(),resources:lease.resources};
      const receipt:AuthorityReceipt={signature,revision:state.revision,result,error:null};const event:CoordinationCommittedEvent={id:uuid(),deviceId:'task-authority',timestamp:Date.now(),type:'project_coordination_committed',protocol:'task-coordination-event/v1',vaultScope:c.vault_scope,authorityId:c.authority_id,projectId:input.project_id,previousRevision:previous.revision,revision:state.revision,operationKey:JSON.stringify([c.host_id,input.operation_id]),signature,issuerId:c.host_id,operationId:input.operation_id,state,receipt,delta:[]};
      try{await this.journal!.append(event);await repo.apply(event);}catch{this.healthy=false;this.suspended=true;fail('authority_unavailable');}return result;
    });
  }
  private async readPriorityEvidence(input:{project_id:string;task_id:string}):Promise<TaskPriorityEvidence|null>{
    if(!input||Object.keys(input).sort().join(',')!=='project_id,task_id'||Object.values(input).some(v=>typeof v!=='string'||!v.trim()))fail('invalid_command');
    const c=this.config;if(!c||this.client)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{await this.repository().replay();await this.repository().assertProjectScope(input.project_id,c.vault_scope,c.authority_id);return this.repository().readPriorityEvidence(input.project_id,input.task_id,c.vault_scope,c.authority_id);});
  }
  async readEffectEvidence(input:{project_id:string;effect_id:string;dispatch_id:string}):Promise<TaskEffectEvidence|null>{
    if(!input||Object.keys(input).sort().join(',')!=='dispatch_id,effect_id,project_id'||Object.values(input).some(v=>typeof v!=='string'||!v.trim()))fail('invalid_command');
    if(this.client)fail('protocol_incompatible');const c=this.config;if(!c)fail('authority_unavailable');
    return this.serializeCurrent(c,async()=>{await this.repository().replay();const state=await this.scopedState(input.project_id,c);const effect=state&&Object.prototype.hasOwnProperty.call(state.effects,input.effect_id)?state.effects[input.effect_id]:undefined;
      if(!effect)return null;if(effect.dispatchId!==input.dispatch_id)fail('fence_rejected');
      return {protocol:'task-effect-verification/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.project_id,effect_id:effect.id,dispatch_id:effect.dispatchId,host_id:effect.hostId,revision:effect.recordRevision??effect.lastRevision,state:effect.state,proposal_ref:copy(effect.proposalRef) as ArtifactRef,proposal_hash:effect.proposalHash,precondition_hash:effect.preconditionHash,capability_ref:copy(effect.capabilityRef) as TaskEffectEvidence['capability_ref'],receipt_ref:effect.receiptRef?copy(effect.receiptRef):null,receipt_hash:effect.receiptRef?.hash??null,record_operation_id:effect.recordOperationId??null,record_operation_signature:effect.recordOperationSignature??null};
    });
  }
  async routeInteractiveMutation(input: {projectId:string;mutation:InteractiveMutation}): Promise<unknown> {
    if(this.client&&this.clientConfig){
      const pending=this.client.pendingEnvelope();if(pending){if(!same((pending.command as Obj).mutation,input.mutation)||pending.project_id!==input.projectId)fail('effect_indeterminate');return this.client.executeCommand(pending);}
      const c=this.clientConfig;const status=await this.client.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.projectId,issuer_id:c.issuer_id}) as {revision:number;admitted:boolean};if(!status.admitted)fail('protocol_incompatible');
      const a=input.mutation.arguments;const resources=[`project:${input.projectId}`];if(typeof a.taskId==='string')resources.push(`task:${a.taskId}`);if(typeof a.parentTaskId==='string')resources.push(`task:${a.parentTaskId}`);for(const id of [...((a.dependsOn??[]) as string[]),...((a.addDependencies??[]) as string[]),...((a.removeDependencies??[]) as string[])])resources.push(`task:${id}`);
      return this.executeCommand({protocol:'task-authority-command/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.projectId,issuer_id:c.issuer_id,operation_id:uuid(),expected_revision:status.revision,command:{type:'interactiveMutation',resources:[...new Set(resources)].sort(),mutation:input.mutation}});
    }
    const c=this.config;if(!c) fail('authority_unavailable'); const state=await this.scopedState(input.projectId,c); if(!state?.admitted) fail('protocol_incompatible');
    const a=input.mutation.arguments; const resources=[`project:${input.projectId}`]; if(typeof a.taskId==='string')resources.push(`task:${a.taskId}`);if(typeof a.parentTaskId==='string')resources.push(`task:${a.parentTaskId}`);for(const id of [...((a.dependsOn??[]) as string[]),...((a.addDependencies??[]) as string[]),...((a.removeDependencies??[]) as string[])])resources.push(`task:${id}`);
    const result=await this.executeCommand({protocol:'task-authority-command/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:input.projectId,issuer_id:c.issuer_id,operation_id:uuid(),expected_revision:state.revision,command:{type:'interactiveMutation',resources:[...new Set(resources)].sort(),mutation:input.mutation}}) as CommandResult;
    return result;
  }
}
const runtimes = new WeakMap<IStorageAdapter,TaskAuthorityRuntime>();
export function getTaskAuthorityRuntime(storage: IStorageAdapter): TaskAuthorityRuntime { let runtime=runtimes.get(storage);if(!runtime){runtime=new TaskAuthorityRuntime(storage);runtimes.set(storage,runtime);}return runtime; }

export async function closeTaskAuthorityRuntime(storage:IStorageAdapter):Promise<void>{await runtimes.get(storage)?.close();}
