import type {TaskAuthorityConfiguration} from './TaskAuthorityRuntime';
import type {TaskCoordinationRepository} from '../../../database/repositories/TaskCoordinationRepository';
import type {AuthorityEffect,AuthorityLease,AuthorityProjectState,OperationalTaskEvent} from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
import type {TaskProjectSource,ArtifactRef} from './TaskAuthorityContracts';
import {authorityHash,canonicalJson} from './TaskAuthorityPlanning';
import {closureObject,closureRef,closureNext,type ClosureEnvelope,type ClosureRecord,type ClosureSubject,type ClosureValidationRequest} from './TaskAuthorityClosureContracts';
import {v4 as uuid} from '../../../utils/uuid';
type Obj=Record<string,unknown>;
const refuse=():never=>{throw Error('fence_rejected');};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
export async function finiteClosure<T>(call:()=>Promise<T>,ms:number|undefined):Promise<T>{
 if(!Number.isSafeInteger(ms)||!ms||ms<1||ms>2147483647)return refuse();let timer:number|undefined;
 try{return await Promise.race([Promise.resolve().then(call),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(Error('fence_rejected')),ms);})]);}finally{if(timer)window.clearTimeout(timer);}
}
export function closureRecord(state:AuthorityProjectState,id:string):ClosureRecord|null{return state.closures&&Object.prototype.hasOwnProperty.call(state.closures,id)?state.closures[id]:null;}
/** No executor lives here: native project archival uses the existing planner;
 * external note/archive effects remain owned by the bound host applicators. */
export class TaskAuthorityClosureService {
 constructor(private readonly repository:TaskCoordinationRepository,private readonly config:TaskAuthorityConfiguration,private readonly epoch:number){}
 private async source(project:string,state:AuthorityProjectState):Promise<TaskProjectSource>{
  const rows=await this.repository.operationalSource(project) as Obj[][],digest=await authorityHash(rows);
  if(!state.admitted||digest!==state.operationalHash||rows[0]?.length!==1||!Array.isArray(rows[1]))return refuse();
  return{protocol:'task-project-source/v1',vault_scope:this.config.vault_scope,authority_id:this.config.authority_id,project_id:project,revision:state.revision,operational_hash:digest,complete:true,project:rows[0][0],tasks:rows[1],dependencies:rows[2],note_links:rows[3],external_children:rows[4]??[]};
 }
 async validate(operation:string,envelope:Obj,state:AuthorityProjectState,subject:ClosureSubject,effect:AuthorityEffect|null,proof_refs:ArtifactRef[]=[]):Promise<void>{
  const c=this.config,record=closureRecord(state,subject.closure_id);if(!c.closureValidator||!c.closure_timeout_ms)return refuse();
  if(!closureNext(record,subject.step)||(operation!=='acquireClosure'&&!record))return refuse();
  const source=await this.source(String(envelope.project_id),state);
  if(source.tasks.some(task=>task.status!=='done')||source.external_children.length||!['active','archived'].includes(String(source.project.status)))return refuse();
  if(source.project.status==='archived'&&(!record||record.steps.length<3)&&!(subject.step==='project_archived_confirmed'&&effect?.closureArchive&&['recordEffect','commitClosureStep','recoverConfirmedEffect'].includes(operation)))return refuse();
  const criteria=record?.criteria_ref??closureRef((envelope.command as Obj).criteria_ref);
  const request:ClosureValidationRequest={protocol:'task-closure-validation/v1',operation,envelope:JSON.parse(JSON.stringify(envelope)) as Obj,source,closure:record,effect,step:subject.step,proof_refs};
  let value:unknown;try{value=await finiteClosure(()=>c.closureValidator!(JSON.parse(JSON.stringify(request)) as ClosureValidationRequest),c.closure_timeout_ms);}catch{return refuse();}
  let result:Obj;try{result=closureObject(value,['protocol','authorized','step','criteria_ref','allow_physical_deferred']);}catch{return refuse();}
  if(result.protocol!=='task-closure-authorization/v1'||result.authorized!==true||result.step!==subject.step||!same(result.criteria_ref,criteria)||typeof result.allow_physical_deferred!=='boolean'||(subject.step==='physical_archive_deferred'&&result.allow_physical_deferred!==true))return refuse();
  if(await this.repository.currentHash(String(envelope.project_id))!==source.operational_hash)return refuse();
 }
 private lease(e:ClosureEnvelope,state:AuthorityProjectState):AuthorityLease{
  const cmd=e.command,lease=state.leases[String(cmd.lease_id)];
  if(!lease||lease.issuer!==this.config.host_id||lease.epoch!==this.epoch||cmd.epoch!==this.epoch||lease.expiresAt<=Date.now()||lease.subject?.kind!=='closure'||lease.subject.closure_id!==cmd.closure_id||lease.taskId!==undefined)return refuse();return lease;
 }
 async reduce(e:ClosureEnvelope,state:AuthorityProjectState,ports:{busy(resources:string[],ownLease?:string):Promise<boolean>;authorize(effect?:AuthorityEffect):Promise<{resources:string[];max_lease_ms:number}>;artifact(ref:ArtifactRef,kind:'proposal'|'receipt'|'evidence',effect?:AuthorityEffect):Promise<void>}):Promise<{delta:OperationalTaskEvent[];result:Obj}>{
  const c=e.command,project=e.project_id,id=String(c.closure_id);let record=closureRecord(state,id);let delta:OperationalTaskEvent[]=[];
  if(c.type==='acquireClosure'){
   const step=c.step as ClosureSubject['step'];if(!closureNext(record,step)||(record&&(!same(record.criteria_ref,c.criteria_ref)||record.initiative_id!==c.initiative_id)))return refuse();
   const subject:ClosureSubject={kind:'closure',closure_id:id,step};await this.validate('acquireClosure',e as unknown as Obj,state,subject,null);
   const auth=await ports.authorize();if(!same(auth.resources,c.resources)||!auth.resources.includes(`project:${project}`)||(c.lease_ms as number)>Math.min(this.config.max_lease_ms,auth.max_lease_ms))return refuse();if(await ports.busy(auth.resources))throw Error('lease_busy');
   if(!record){record={id,initiative_id:String(c.initiative_id),criteria_ref:closureRef(c.criteria_ref),source_revision:state.revision,steps:[]};state.closures={...state.closures,[id]:record};}
   const lease:AuthorityLease={id:uuid(),issuer:this.config.host_id,epoch:this.epoch,expiresAt:Date.now()+(c.lease_ms as number),maxLeaseMs:Math.min(this.config.max_lease_ms,auth.max_lease_ms),resources:[...auth.resources],subject};state.leases[lease.id]=lease;state.epoch=this.epoch;
   return{delta,result:{status:'acquired',epoch:this.epoch,lease_id:lease.id,expires_at:new Date(lease.expiresAt).toISOString(),resources:lease.resources}};
  }
  const lease=this.lease(e,state),subject=lease.subject!;if(!record||!closureNext(record,subject.step))return refuse();
  const effect=Object.prototype.hasOwnProperty.call(state.effects,String(c.effect_id))?state.effects[String(c.effect_id)]:undefined;
  if(!effect||effect.leaseId!==lease.id||!same(effect.subject,subject)||effect.hostId!==this.config.host_id)return refuse();
  if(c.type==='archiveClosureProject'){
   if(subject.step!=='project_archived_confirmed'||record.steps.length!==2||effect.state!=='started'||effect.dispatchId!==c.dispatch_id||effect.closureArchive)return refuse();
   const source=await this.source(project,state);if(source.project.status!=='active')return refuse();
   await this.validate('archiveClosureProject',e as unknown as Obj,state,subject,effect,[closureRef(c.gate_proof_ref)]);const auth=await ports.authorize(effect);if(!same(auth.resources,lease.resources))return refuse();await ports.artifact(closureRef(c.gate_proof_ref),'evidence',effect);
   const prepared=await this.repository.prepare(project,{kind:'archiveProject',arguments:{projectId:project}});delta=prepared.delta;
   effect.closureArchive={operation_id:e.operation_id,operation_signature:await authorityHash(e),before_hash:state.operationalHash,after_hash:prepared.operationalHash,revision:state.revision+1,gate_proof_ref:closureRef(c.gate_proof_ref)};state.operationalHash=prepared.operationalHash;effect.lastRevision=state.revision+1;
   return{delta,result:{status:'committed',kind:'archiveProject',entity_id:project}};
  }
  if(c.type!=='commitClosureStep'||c.step!==subject.step||effect.state!=='confirmed'||!same(effect.receiptRef,c.receipt_ref))return refuse();
  if(subject.step==='project_archived_confirmed'&&(!effect.closureArchive||effect.closureArchive.after_hash!==state.operationalHash))return refuse();
  const refs=c.evidence_refs as ArtifactRef[];await this.validate('commitClosureStep',e as unknown as Obj,state,subject,effect,refs);const auth=await ports.authorize(effect);if(!same(auth.resources,lease.resources))return refuse();await ports.artifact(closureRef(c.receipt_ref),'receipt',effect);for(const ref of refs)await ports.artifact(ref,'evidence',effect);
  record.steps.push({kind:subject.step,effect_id:effect.id,receipt_ref:closureRef(c.receipt_ref),proof_refs:refs,revision:state.revision+1});effect.state='committed';effect.lastRevision=state.revision+1;
  return{delta,result:{status:'committed',kind:'closure_step',entity_id:id}};
 }
}
