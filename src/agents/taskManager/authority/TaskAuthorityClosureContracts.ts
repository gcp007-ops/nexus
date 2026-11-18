import { normalizeResourceList, type ArtifactRef, type TaskProjectSource } from './TaskAuthorityContracts';
import type { AuthorityEffect } from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
export const CLOSURE_STEPS=['gate_confirmed','note_terminal_confirmed','project_archived_confirmed','physical_archive_confirmed','closure_verified'] as const;
export type ClosureStep=typeof CLOSURE_STEPS[number]|'physical_archive_deferred';
export interface ClosureRecord {id:string;initiative_id:string;criteria_ref:ArtifactRef;source_revision:number;steps:Array<{kind:ClosureStep;effect_id:string;receipt_ref:ArtifactRef;proof_refs:ArtifactRef[];revision:number}>}
export interface ClosureSubject {kind:'closure';closure_id:string;step:ClosureStep}
export interface ClosureValidationRequest {protocol:'task-closure-validation/v1';operation:string;envelope:Record<string,unknown>;source:TaskProjectSource;closure:ClosureRecord|null;effect:AuthorityEffect|null;archive_effect:AuthorityEffect|null;step:ClosureStep;proof_refs:ArtifactRef[]}
export interface ClosureAuthorization {protocol:'task-closure-authorization/v1';authorized:true;step:ClosureStep;criteria_ref:ArtifactRef;allow_physical_deferred:boolean}
export interface ClosureEnvelope {protocol:'task-closure-command/v1';vault_scope:string;authority_id:string;project_id:string;issuer_id:string;operation_id:string;expected_revision:number;command:Record<string,unknown>}
const invalid=():never=>{throw Error('invalid_command');};
export function closureObject(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))return invalid();return v as Record<string,unknown>;}
export function closureId(v:unknown):string{return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)?v:invalid();}
export function closureRef(v:unknown):ArtifactRef{const r=closureObject(v,['artifact_id','hash']);if(r.artifact_id!==r.hash||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))return invalid();return r as unknown as ArtifactRef;}
export function closureStep(v:unknown):ClosureStep{return typeof v==='string'&&[...CLOSURE_STEPS,'physical_archive_deferred'].includes(v)?v as ClosureStep:invalid();}
export function closureNext(record:ClosureRecord|null,step:ClosureStep):boolean{const n=record?.steps.length??0;return CLOSURE_STEPS[n]===step||(n===3&&step==='physical_archive_deferred');}
export function normalizeClosureCommand(value:unknown):ClosureEnvelope{
 const e=closureObject(value,['protocol','vault_scope','authority_id','project_id','issuer_id','operation_id','expected_revision','command']);if(e.protocol!=='task-closure-command/v1')return invalid();
 for(const k of ['vault_scope','authority_id','project_id','issuer_id','operation_id'])closureId(e[k]);if(!Number.isSafeInteger(e.expected_revision)||(e.expected_revision as number)<0)return invalid();
 if(!e.command||typeof e.command!=='object'||Array.isArray(e.command))return invalid();const c=e.command as Record<string,unknown>;
 const variants:Record<string,string[]>={acquireClosure:['closure_id','initiative_id','criteria_ref','step','capability_ref','resources','lease_ms'],commitClosureStep:['closure_id','step','lease_id','epoch','effect_id','receipt_ref','evidence_refs'],archiveClosureProject:['closure_id','lease_id','epoch','effect_id','dispatch_id','gate_proof_ref']};
 const fields=typeof c.type==='string'?variants[c.type]:undefined;if(!fields||!Object.prototype.hasOwnProperty.call(variants,String(c.type)))return invalid();closureObject(c,['type',...fields]);closureId(c.closure_id);
 if(c.type==='acquireClosure'){closureId(c.initiative_id);closureRef(c.criteria_ref);closureStep(c.step);const r=closureObject(c.capability_ref,['id','version','revision','hash']);closureId(r.id);for(const k of ['version','revision'])if(!Number.isSafeInteger(r[k])||(r[k] as number)<1)return invalid();if(typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))return invalid();normalizeResourceList(c.resources);if(!Number.isSafeInteger(c.lease_ms)||(c.lease_ms as number)<=0)return invalid();}
 else{for(const k of ['lease_id','effect_id'])closureId(c[k]);if(!Number.isSafeInteger(c.epoch)||(c.epoch as number)<0)return invalid();if(c.type==='commitClosureStep'){closureStep(c.step);closureRef(c.receipt_ref);if(!Array.isArray(c.evidence_refs)||!c.evidence_refs.length)return invalid();c.evidence_refs.forEach(closureRef);}else{closureId(c.dispatch_id);closureRef(c.gate_proof_ref);}}
 return JSON.parse(JSON.stringify(e)) as ClosureEnvelope;
}
