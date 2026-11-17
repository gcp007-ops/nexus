import { requestUrl } from 'obsidian';
import type { SecretStore } from '../../../services/secrets/SecretStore';
import { normalizeCommand,normalizeQuery,normalizeCommandResult,normalizeQueryResult,type CommandResult } from './TaskAuthorityContracts';
import { authorityHash,canonicalJson } from './TaskAuthorityPlanning';
export interface TaskAuthorityClientConfiguration { protocol:'task-authority-config/v1'; mode:'client'; vault_scope:string;authority_id:string;issuer_id:string;service_origin:string;tls_trust:'system';credential_secret_id:string;max_request_bytes:number;request_timeout_ms:number }
export function validateClientConfiguration(value:unknown):TaskAuthorityClientConfiguration {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_command');const c=value as Record<string,unknown>;
  const fields=['protocol','mode','vault_scope','authority_id','issuer_id','service_origin','tls_trust','credential_secret_id','max_request_bytes','request_timeout_ms'];if(Object.keys(c).some(k=>!fields.includes(k))||fields.some(k=>!(k in c))||c.protocol!=='task-authority-config/v1'||c.mode!=='client'||c.tls_trust!=='system')throw new Error('invalid_command');
  for(const k of ['vault_scope','authority_id','issuer_id','service_origin','credential_secret_id'])if(typeof c[k]!=='string'||!(c[k]).trim())throw new Error('invalid_command');
  const url=new URL(String(c.service_origin));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('invalid_command');
  for(const k of ['max_request_bytes','request_timeout_ms'])if(!Number.isSafeInteger(c[k])||(c[k] as number)<=0)throw new Error('invalid_command');
  return {...c,service_origin:url.origin} as unknown as TaskAuthorityClientConfiguration;
}
export class TaskAuthorityHttpClient {
  private readonly uncertain=new Map<string,string>();
  private pendingKey: string | null = null;
  private pending: Record<string,unknown> | null = null;
  async initialize(): Promise<void> { this.pendingKey = `nexus-task-authority-pending-${(await authorityHash([this.config.vault_scope,this.config.authority_id,this.config.issuer_id])).slice(0,32)}`;const saved=this.secrets.get(this.pendingKey);if(saved){this.pending=normalizeCommand(JSON.parse(saved));this.uncertain.set(JSON.stringify([this.pending.project_id,this.pending.issuer_id,this.pending.operation_id]),canonicalJson(this.pending));} }
  pendingEnvelope(): Record<string,unknown> | null { return this.pending ? JSON.parse(JSON.stringify(this.pending)) as Record<string,unknown> : null; }
  private remember(e:Record<string,unknown>):void { if(!this.pendingKey)throw new Error("authority_unavailable");const text=JSON.stringify(e);if(!this.secrets.set(this.pendingKey,text)||this.secrets.get(this.pendingKey)!==text)throw new Error("authority_unavailable");this.pending=e; }
  private forget():void {if(!this.pendingKey||!this.secrets.clear(this.pendingKey)||this.secrets.get(this.pendingKey))throw new Error("authority_unavailable");this.pending=null;}
  constructor(private readonly config:TaskAuthorityClientConfiguration,private readonly secrets:SecretStore){if(!secrets.isAvailable()||!secrets.get(config.credential_secret_id))throw new Error('authority_unavailable');}
  private scope(e:Record<string,unknown>):void{if(e.vault_scope!==this.config.vault_scope||e.authority_id!==this.config.authority_id||e.issuer_id!==this.config.issuer_id)throw new Error('unauthorized');}
  private async send(path:string,envelope:Record<string,unknown>):Promise<unknown>{
    this.scope(envelope);const secret=this.secrets.get(this.config.credential_secret_id);if(!this.secrets.isAvailable()||!secret)throw new Error('authority_unavailable');const body=JSON.stringify(envelope);if(new TextEncoder().encode(body).byteLength>this.config.max_request_bytes)throw new Error('invalid_command');
    let timer:number|undefined;
    try {const response=await Promise.race([requestUrl({url:this.config.service_origin+path,method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${secret}`},body,throw:false}),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('effect_indeterminate')),this.config.request_timeout_ms);})]);
      if(response.status!==200){const data=response.json as Record<string,unknown>|null;const error=data&&typeof data==='object'&&typeof data.error==='string'?data.error:'authority_unavailable';if(!['authority_unavailable','revision_conflict','lease_busy','stale_epoch','fence_rejected','operation_signature_conflict','effect_indeterminate','capability_revoked','protocol_incompatible','invalid_command','unauthorized'].includes(error))throw new Error('protocol_incompatible');throw new Error(error);}
      if(new TextEncoder().encode(response.text).byteLength>this.config.max_request_bytes)throw new Error('protocol_incompatible');return response.json as unknown;
    }finally{if(timer)window.clearTimeout(timer);}
  }
  async query(value:unknown):Promise<unknown>{const e=normalizeQuery(value);return normalizeQueryResult(await this.send('/v1/task-authority/query',e));}
  async executeCommand(value:unknown):Promise<unknown>{const e=normalizeCommand(value);this.scope(e);const key=JSON.stringify([e.project_id,e.issuer_id,e.operation_id]);const signature=canonicalJson(e);
    if(this.pending && canonicalJson(this.pending)!==signature)throw new Error('effect_indeterminate');
    const old=this.uncertain.get(key);if(old){if(old!==signature)throw new Error('operation_signature_conflict');const result=await this.query({protocol:'task-authority-query/v1',type:'getOperation',vault_scope:e.vault_scope,authority_id:e.authority_id,project_id:e.project_id,issuer_id:e.issuer_id,operation_id:e.operation_id}) as {result:CommandResult|null;error:string|null};if(result.error){this.forget();this.uncertain.delete(key);throw new Error(result.error);}if(result.result){this.forget();this.uncertain.delete(key);return result.result;}throw new Error('effect_indeterminate');}
    this.remember(e);
    try{const result=normalizeCommandResult(await this.send('/v1/task-authority/commands',e));for(const k of ['vault_scope','authority_id','project_id','issuer_id','operation_id'])if(result[k as keyof CommandResult]!==e[k])throw new Error('protocol_incompatible');this.forget();return result;}
    catch(error){if(!(error instanceof Error)||!['revision_conflict','lease_busy','stale_epoch','fence_rejected','operation_signature_conflict','capability_revoked','invalid_command','unauthorized'].includes(error.message)){this.uncertain.set(key,signature);throw new Error('effect_indeterminate');}this.forget();throw error;}
  }
}
