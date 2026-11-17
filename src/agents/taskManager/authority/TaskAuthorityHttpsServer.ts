import type { SecretStore } from '../../../services/secrets/SecretStore';
import { desktopRequire } from '../../../utils/desktopRequire';
import { isDesktop } from '../../../utils/platform';
import { normalizeCommand,normalizeQuery,normalizeCommandResult,normalizeQueryResult } from './TaskAuthorityContracts';
import type { TaskAuthorityRuntime } from './TaskAuthorityRuntime';
export interface AuthorityClientAuthorization {issuer_id:string;credential_secret_id:string;project_ids:string[];command_types:string[]}
export interface TaskAuthorityServerConfiguration {host:string;port:number;certificate_secret_id:string;key_secret_id:string;max_request_bytes:number;request_timeout_ms:number;max_connections:number;clients:AuthorityClientAuthorization[]}
export function validateServerConfiguration(value:unknown):TaskAuthorityServerConfiguration {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_command');const c=value as Record<string,unknown>;const fields=['host','port','certificate_secret_id','key_secret_id','max_request_bytes','request_timeout_ms','max_connections','clients'];if(Object.keys(c).some(k=>!fields.includes(k))||fields.some(k=>!(k in c)))throw new Error('invalid_command');
  for(const k of ['host','certificate_secret_id','key_secret_id'])if(typeof c[k]!=='string'||!(c[k]).trim())throw new Error('invalid_command');for(const k of ['port','max_request_bytes','request_timeout_ms','max_connections'])if(!Number.isSafeInteger(c[k])||(c[k] as number)<=0)throw new Error('invalid_command');if((c.port as number)>65535||!Array.isArray(c.clients)||!c.clients.length)throw new Error('invalid_command');
  const seen=new Set<string>();const commands=['admitProject','acquireUnit','renewLease','releaseLease','dispatchEffect','beginEffect','recordEffect','commitProgress','interactiveMutation'];
  for(const item of c.clients){if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('invalid_command');const v=item as Record<string,unknown>;if(Object.keys(v).sort().join(',')!=='command_types,credential_secret_id,issuer_id,project_ids'||typeof v.issuer_id!=='string'||!v.issuer_id.trim()||seen.has(v.issuer_id)||typeof v.credential_secret_id!=='string'||!v.credential_secret_id.trim()||!Array.isArray(v.project_ids)||!v.project_ids.length||v.project_ids.some(p=>typeof p!=='string'||!p.trim())||!Array.isArray(v.command_types)||v.command_types.some(t=>!commands.includes(String(t))))throw new Error('invalid_command');seen.add(v.issuer_id);}
  return JSON.parse(JSON.stringify(c)) as TaskAuthorityServerConfiguration;
}
/** Restricted TLS listener. It cannot dispatch arbitrary tools, shell or files. */
export class TaskAuthorityHttpsServer {
  private server:import('node:https').Server|null=null;
  constructor(private readonly config:TaskAuthorityServerConfiguration,private readonly secrets:SecretStore,private readonly runtime:TaskAuthorityRuntime){}
  async start():Promise<void>{
    if(!isDesktop()||!this.secrets.isAvailable()||this.server)throw new Error('authority_unavailable');
    const cert=this.secrets.get(this.config.certificate_secret_id),key=this.secrets.get(this.config.key_secret_id);if(!cert||!key||this.config.clients.some(c=>!this.secrets.get(c.credential_secret_id)))throw new Error('authority_unavailable');
    const https=desktopRequire<typeof import('node:https')>('node:https');const crypto=desktopRequire<typeof import('node:crypto')>('node:crypto');
    const server=https.createServer({cert,key,minVersion:'TLSv1.2'},(request,response)=>{
      const send=(status:number,value:unknown):void=>{if(!response.writableEnded){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));}};
      if(request.method!=='POST'||!['/v1/task-authority/commands','/v1/task-authority/query'].includes(request.url??'')||!/^application\/json(?:;|$)/i.test(request.headers['content-type']??'')){send(400,{error:'invalid_command'});request.resume();return;}
      const authorization=request.headers.authorization;let client:AuthorityClientAuthorization|undefined;
      if(this.secrets.isAvailable()&&authorization?.startsWith('Bearer '))for(const candidate of this.config.clients){const secret=this.secrets.get(candidate.credential_secret_id);if(secret){const expected=crypto.createHash('sha256').update(secret).digest();const actual=crypto.createHash('sha256').update(authorization.slice(7)).digest();if(crypto.timingSafeEqual(actual,expected))client=candidate;}}
      if(!client){send(401,{error:'unauthorized'});request.resume();return;}
      const authenticated=client;const chunks:Buffer[]=[];let bytes=0;let rejected=false;
      request.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>this.config.max_request_bytes){rejected=true;send(413,{error:'invalid_command'});chunks.length=0;}else if(!rejected)chunks.push(chunk);});
      request.on('error',()=>{send(400,{error:'invalid_command'});});
      request.on('end',()=>{if(rejected)return;void(async()=>{try{const input:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));const isCommand=request.url==='/v1/task-authority/commands';const envelope=isCommand?normalizeCommand(input):normalizeQuery(input);if(envelope.issuer_id!==authenticated.issuer_id||!authenticated.project_ids.includes(String(envelope.project_id))||(isCommand&&!authenticated.command_types.includes(String((envelope.command as Record<string,unknown>).type)))){send(403,{error:'unauthorized'});return;}
        const result=isCommand?normalizeCommandResult(await this.runtime.executeCommand(envelope,authenticated.issuer_id)):normalizeQueryResult(await this.runtime.query(envelope,authenticated.issuer_id));send(200,result);
      }catch(error){const code=error instanceof Error?error.message:'authority_unavailable';const allowed=['authority_unavailable','revision_conflict','lease_busy','stale_epoch','fence_rejected','operation_signature_conflict','effect_indeterminate','capability_revoked','protocol_incompatible','invalid_command','unauthorized'];send(allowed.includes(code)?409:503,{error:allowed.includes(code)?code:'authority_unavailable'});}})();});
    });
    server.maxConnections=this.config.max_connections;server.requestTimeout=this.config.request_timeout_ms;server.headersTimeout=this.config.request_timeout_ms;server.timeout=this.config.request_timeout_ms;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.config.port,this.config.host,()=>{server.removeListener('error',reject);resolve();});});this.server=server;
  }
  async stop():Promise<void>{const server=this.server;this.server=null;if(!server)return;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
