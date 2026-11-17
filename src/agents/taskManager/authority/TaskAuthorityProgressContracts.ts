import type {ArtifactRef,TaskProjectSource} from './TaskAuthorityContracts';
import type {AuthorityEffect} from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
export interface TaskProgressAuthorization {protocol:'task-progress-authorization/v1';consumption_capability_ref:{id:string;version:number;revision:number;hash:string};consumption_profile_ref:{id:string;version:number;hash:string};proof_refs:ArtifactRef[]}
export interface TaskProgressValidationRequest {protocol:'task-progress-validation/v1';envelope:Record<string,unknown>;source:TaskProjectSource;effect:AuthorityEffect;transition:{task_id:string;expected_status:string;next_status:string;receipt_ref:ArtifactRef;evidence_refs:ArtifactRef[]}}
export type TaskProgressConsumptionBinding=Omit<TaskProgressAuthorization,'protocol'>&{source_revision:number;operational_hash:string};
export function normalizeProgressAuthorization(value:unknown):TaskProgressAuthorization {
 const object=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))throw Error('fence_rejected');return v as Record<string,unknown>;};
 const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);const positive=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0;
 const r=object(value,['protocol','consumption_capability_ref','consumption_profile_ref','proof_refs']);if(r.protocol!=='task-progress-authorization/v1')throw Error('fence_rejected');
 const cap=object(r.consumption_capability_ref,['id','version','revision','hash']),profile=object(r.consumption_profile_ref,['id','version','hash']);if(!id(cap.id)||!positive(cap.version)||!positive(cap.revision)||!hash(cap.hash)||!id(profile.id)||!positive(profile.version)||!hash(profile.hash)||!Array.isArray(r.proof_refs)||!r.proof_refs.length)throw Error('fence_rejected');
 for(const v of r.proof_refs){const ref=object(v,['artifact_id','hash']);if(!hash(ref.hash)||ref.artifact_id!==ref.hash)throw Error('fence_rejected');}return JSON.parse(JSON.stringify(r)) as TaskProgressAuthorization;
}
