import { SecretStore, type SecretStorageHost } from '../../../services/secrets/SecretStore';
type SecretKind='client-credential'|'server-certificate'|'server-key';
interface Identity {kind:SecretKind;identity:string}
interface Status {protocol:'task-authority-secret-status/v1';secret_id:string;available:boolean;present:boolean}
function identity(input:unknown,fields:string[]):Identity&Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)throw Error('invalid_command');
  const v=input as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!==fields.sort().join(',')||!['client-credential','server-certificate','server-key'].includes(String(v.kind))||typeof v.identity!=='string'||`nexus-task-authority-${String(v.kind)}-${v.identity}`.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.identity))throw Error('invalid_command');
  return v as Identity&Record<string,unknown>;
}
/** Trusted, local administrative surface. Not registered as a tool or network
 * route. Uses the existing device-local SecretStore without a plaintext fallback.
 * Values never appear in status, errors, configuration or execution receipts. */
export class TaskAuthorityProvisioning {
  readonly protocol='task-authority-provisioning/v1';
  private readonly secrets:SecretStore;
  constructor(host:SecretStorageHost){this.secrets=new SecretStore(host);}
  private secretId(v:Identity):string{return `nexus-task-authority-${v.kind}-${v.identity}`;}
  status(input:unknown):Status{const v=identity(input,['kind','identity']);return{protocol:'task-authority-secret-status/v1',secret_id:this.secretId(v),available:this.secrets.isAvailable(),present:!!this.secrets.get(this.secretId(v))};}
  put(input:unknown):Status{
    const v=identity(input,['kind','identity','value','replace']);
    if(typeof v.value!=='string'||!v.value.trim()||typeof v.replace!=='boolean')throw Error('invalid_command');
    const key=this.secretId(v);if(!this.secrets.isAvailable())throw Error('authority_unavailable');
    if(this.secrets.get(key)&&!v.replace)throw Error('secret_already_present');
    if(!this.secrets.set(key,v.value)||this.secrets.get(key)!==v.value)throw Error('authority_unavailable');
    return this.status({kind:v.kind,identity:v.identity});
  }
  clear(input:unknown):Status{const v=identity(input,['kind','identity']),key=this.secretId(v);if(!this.secrets.isAvailable()||!this.secrets.clear(key)||this.secrets.get(key))throw Error('authority_unavailable');return this.status({kind:v.kind,identity:v.identity});}
}
