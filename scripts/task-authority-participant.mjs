/** Internal live-driver modes. All mutations are confined to a marked QA project. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireValue = (condition, message) => { if (!condition) throw Error(message); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const exclusive = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag:'wx',mode:0o600});

export function parseLiveOptions(args) {
  const options = {};
  const values = new Set(['--mode','--phase','--vault','--expected-path','--run-id','--output-root','--participant-file']);
  for (let i=0; i<args.length; i++) {
    const key=args[i];
    requireValue(!(key in options), 'Duplicate option');
    if (key==='--require-obsidian') options[key]=true;
    else { requireValue(values.has(key) && args[i+1] && !args[i+1].startsWith('--'), 'Unknown or missing option'); options[key]=args[++i]; }
  }
  requireValue(['authority','client','reconcile'].includes(options['--mode']), 'Expected --mode authority|client|reconcile');
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options['--run-id']||''), 'Explicit safe --run-id required');
  requireValue(options['--output-root'], 'Explicit external --output-root required');
  return options;
}

function cli(vault, ...args) {
  const command=process.platform==='win32'?'obsidian.com':'obsidian';
  const result=spawnSync(command,[`vault=${vault}`,...args],{encoding:'utf8',timeout:30000});
  requireValue(!result.error && result.status===0 && !/^Error:/m.test(result.stdout), result.error?.message || result.stdout+result.stderr);
  return result.stdout;
}
function evaluate(vault, fn, input) {
  let code=`(${fn.toString()})(${JSON.stringify(input)})`;
  // Base64 avoids both Windows native quote loss and shell metacharacters.
  const encoded=Buffer.from(code).toString('base64');
  code=`eval(Buffer.from('${encoded}','base64').toString('utf8'))`;
  const result=cli(vault,'eval',`code=${code}`),offset=result.lastIndexOf('=> ');
  requireValue(offset>=0,result);return JSON.parse(result.slice(offset+3));
}
function identity(options) {
  const name=options['--vault'],path=realpathSync(options['--expected-path']);
  requireValue(options['--require-obsidian'] && /authority-qa-/.test(name||''), 'Explicit marked QA vault and --require-obsidian required');
  requireValue(json(join(path,'.task-authority-qa.json')).protocol==='task-authority-disposable-qa/v1', 'Disposable QA marker required');
  const actual=evaluate(name,()=>({name:app.vault.getName(),path:app.vault.adapter.getBasePath()}));
  requireValue(equal(actual,{name,path}), 'Wrong native vault');
  const outputRelative=relative(path,resolve(options['--output-root']));
  requireValue(outputRelative!==''&&(outputRelative.startsWith('..')||isAbsolute(outputRelative)), 'Evidence must stay outside the vault');return actual;
}
function config(options) {
  const value=json(options['--participant-file']);
  const fields=['protocol','run_id','vault_scope','authority_id','project_id','issuer_id','service_origin','credential_secret_id'];
  requireValue(Object.keys(value).sort().join()===fields.sort().join(), 'Closed public participant configuration required; never pass credential values');
  requireValue(value.protocol==='task-authority-qa-participant/v1' && value.run_id===options['--run-id'], 'Participant run mismatch');
  for (const key of fields) requireValue(typeof value[key]==='string' && value[key].length>0, 'Missing participant field');
  requireValue(value.vault_scope==='qa-'+value.run_id && value.authority_id==='qa-authority-'+value.run_id, 'Participant does not match synthetic fixture');
  const origin=new URL(value.service_origin);
  requireValue(origin.protocol==='https:' && !origin.username && !origin.password && value.service_origin===origin.origin && /^nexus-task-authority-client-credential-/.test(value.credential_secret_id), 'System TLS and namespaced preprovisioned credential required');
  return value;
}
async function connect(input) {
  if(app.vault.getName()!==input.identity.name||app.vault.adapter.getBasePath()!==input.identity.path)throw Error('Wrong QA vault');
  const service=await app.plugins.plugins.nexus.getService('taskService'),c=input.config;
  await service.configureTaskAuthority({protocol:'task-authority-config/v1',mode:'client',vault_scope:c.vault_scope,authority_id:c.authority_id,issuer_id:c.issuer_id,service_origin:c.service_origin,tls_trust:'system',credential_secret_id:c.credential_secret_id,max_request_bytes:16384,request_timeout_ms:5000});
  const a=service.getTaskAuthority(),query={protocol:'task-authority-query/v1',type:'getOperation',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:c.project_id,issuer_id:c.issuer_id,operation_id:'participant-create-'+c.run_id};
  return {service,a,query};
}

export function reconcileProofs(authority, client, readback, run) {
  requireValue(authority.state==='passed' && client.state==='passed' && readback.state==='passed', 'Every participant must pass');
  requireValue([authority,client,readback].every(p=>p.run_id===run), 'Run identities differ');
  requireValue(authority.fixture?.scope===client.scope && client.scope===readback.scope, 'Scope identities differ');
  requireValue(authority.fixture.p===client.project_id && client.project_id===readback.project_id, 'Project identities differ');
  requireValue(authority.host!==client.host, 'Remote participant must execute on a different host');
  requireValue(equal(client.receipt,readback.receipt) && equal(client.receipt,client.after_reload), 'Canonical receipt differs across participant/restart');
  requireValue(readback.native_count===1 && readback.priority_source_issuer===client.issuer_id, 'Independent source lacks unique creation/authentic priority');
  requireValue(client.tls_trust==='system' && client.native_client===true, 'Real native client with system TLS required');
  return {protocol:'task-authority-live-reconciliation/v1',run_id:run,state:'passed',coverage:'Authority/WASM/UI/restart plus remote native-client creation and independent canonical readback. Host effects and interrupted closure require their separate integration evidence.'};
}

export async function participantMode(options) {
  const root=resolve(options['--output-root']),run=options['--run-id'];mkdirSync(root,{recursive:true});
  if(options['--mode']==='reconcile') {
    const names=['authority-app-proof.json','client-app-proof.json','authority-client-readback.json'];
    const proofs=names.map(n=>json(join(root,n))),result=reconcileProofs(...proofs,run);
    result.inputs=names.map(n=>({name:n,sha256:hash(readFileSync(join(root,n)))}));
    exclusive(join(root,'reconciliation.json'),result);console.log(JSON.stringify(result));return;
  }
  const target=identity(options),c=config(options),phase=options['--phase']||'create';
  const input={identity:target,config:c};
  if(options['--mode']==='authority') {
    requireValue(phase==='readback','Authority participant phase must be readback');
    const client=json(join(root,'client-app-proof.json'));
    requireValue(client.run_id===run && client.project_id===c.project_id,'Client evidence mismatch');
    const result=evaluate(target.name,async input=>{
      const f=window.__authorityQA?.fixture;
      if(app.vault.adapter.getBasePath()!==input.identity.path||!f||f.scope!==input.config.vault_scope||f.p!==input.config.project_id)throw Error('Wrong authority fixture');
      const c=input.config;
      const source=await window.__authorityQAHost.readProjectSnapshot({project_id:c.project_id});
      // Read the replayed canonical repository locally. Never impersonate the
      // remote issuer through the authority's human facade.
      const receipt=await window.__authorityQA.adapter.taskCoordination.getReceipt(c.project_id,c.issuer_id,'participant-create-'+c.run_id);
      if(!receipt?.result||receipt.error||receipt.result.status!=='committed')throw Error('No committed client operation');
      const priority=await window.__authorityQAHost.readPriorityEvidence({project_id:c.project_id,task_id:receipt.result.entity_id});
      return {receipt:receipt.result,native_count:source.tasks.filter(t=>t.id===receipt.result.entity_id).length,priority_source_issuer:priority?.source_issuer_id};
    },input);
    exclusive(join(root,'authority-client-readback.json'),{protocol:'task-authority-client-readback/v1',state:'passed',run_id:run,scope:c.vault_scope,project_id:c.project_id,...result});return;
  }
  requireValue(['create','recover'].includes(phase),'Client phase must be create|recover');
  evaluate(target.name,async input=>{await eval('('+input.connect+')')(input);return {configured:true};},{...input,connect:connect.toString()});
  const intentPath=join(root,'client-intent.json');
  if(phase==='recover') {
    const intent=json(intentPath);requireValue(intent.run_id===run,'Intent mismatch');
    const result=evaluate(target.name,async input=>{
      const {a,query}=await eval('('+input.connect+')')(input);
      // No executeCommand here: not_found never authorizes a resend.
      return await a.query(query);
    },{...input,connect:connect.toString()});
    exclusive(join(root,'client-recovery.json'),{protocol:'task-authority-query-only-recovery/v1',run_id:run,result});return;
  }
  requireValue(!existsSync(intentPath) && !existsSync(join(root,'client-app-proof.json')),'Existing intent requires query-only recover; do not replay');
  const command=evaluate(target.name,async input=>{
    const {a}=await eval('('+input.connect+')')(input),c=input.config;
    const status=await a.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:c.project_id,issuer_id:c.issuer_id});
    return {protocol:'task-authority-command/v1',vault_scope:c.vault_scope,authority_id:c.authority_id,project_id:c.project_id,issuer_id:c.issuer_id,operation_id:'participant-create-'+c.run_id,expected_revision:status.revision,command:{type:'interactiveMutation',resources:['project:'+c.project_id],mutation:{kind:'createTask',arguments:{projectId:c.project_id,title:'Remote native QA '+c.run_id,priority:'high'}}}};
  },{...input,connect:connect.toString()});
  exclusive(intentPath,{run_id:run,command});
  const first=evaluate(target.name,async input=>{const {a}=await eval('('+input.connect+')')(input);return await a.executeCommand(input.command);},{...input,connect:connect.toString(),command});
  // A confirmed result may be repeated to prove durable idempotency. An unknown
  // result exits above with the immutable intent intact and must use recover.
  cli(target.name,'plugin:reload','id=nexus');
  const after=evaluate(target.name,async input=>{const {a,query}=await eval('('+input.connect+')')(input);const read=await a.query(query);if(read.state!=='committed')throw Error('Receipt missing after restart');return {read,repeat:await a.executeCommand(input.command)};},{...input,connect:connect.toString(),command});
  requireValue(equal(first,after.read.result)&&equal(first,after.repeat),'Receipt changed after restart');
  exclusive(join(root,'client-app-proof.json'),{protocol:'task-authority-native-client-proof/v1',state:'passed',run_id:run,host:hostname(),native_client:true,tls_trust:'system',scope:c.vault_scope,project_id:c.project_id,issuer_id:c.issuer_id,receipt:first,after_reload:after.repeat,installed_main_sha256:hash(readFileSync(join(target.path,'.obsidian/plugins/nexus/main.js')))});
}
