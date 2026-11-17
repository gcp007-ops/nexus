#!/usr/bin/env node
/** Real Obsidian/WASM smoke test. Requires an explicitly marked disposable vault.
 * It grants only synthetic leases: every artifact/effect is refused. It does not
 * qualify host application, remote TLS participants or productive capabilities.
 * Example: node scripts/verify-task-authority.mjs --vault dream-authority-qa-X
 *   --expected-path /external/qa-vault --artifacts-dir /external/qa-results
 * Place {"protocol":"task-authority-disposable-qa/v1"} in
 * .task-authority-qa.json at the disposable vault root before running.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { parseLiveOptions, participantMode } from './task-authority-participant.mjs';
const originalArgs=process.argv.slice(2),live=originalArgs.includes('--mode')?parseLiveOptions(originalArgs):null;
if(live?.['--mode']==='authority'&&!live['--require-obsidian'])throw Error('Authority mode requires --require-obsidian');
if(live && (live['--mode']!=='authority'||live['--phase']==='readback')) {
  await participantMode(live);process.exit(0);
}
const args=live?['--vault',live['--vault'],'--expected-path',live['--expected-path'],'--artifacts-dir',live['--output-root']]:originalArgs,options={};
for(let i=0;i<args.length;i+=2){if(!['--vault','--expected-path','--artifacts-dir'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Required: --vault --expected-path --artifacts-dir');options[args[i]]=args[i+1];}
if(Object.keys(options).length!==3)throw Error('Required: --vault --expected-path --artifacts-dir');
const vault=options['--vault'],expected=realpathSync(options['--expected-path']),artifacts=resolve(options['--artifacts-dir']);
if(!/authority-qa-/.test(vault)||JSON.parse(readFileSync(join(expected,'.task-authority-qa.json'),'utf8')).protocol!=='task-authority-disposable-qa/v1')throw Error('Explicit disposable QA marker required');
mkdirSync(artifacts,{recursive:true});
if(existsSync(join(artifacts,'authority-app-proof.json')))throw Error('Existing authority report; inspect receipts instead of replaying fixture creation');
const report={protocol:'task-authority-app-proof/v1',run_id:live?.['--run-id']||randomUUID(),host:hostname(),started_at:new Date().toISOString(),vault,expected_path:expected,coverage:'local authority, real WASM, CLI, board and restart; no external effect or remote TLS qualification',steps:[]};
function cli(...command){const r=spawnSync('obsidian',[`vault=${vault}`,...command],{encoding:'utf8',timeout:30000});if(r.status!==0||r.error||/^Error:/m.test(r.stdout))throw Error(r.error?.message||r.stdout+r.stderr);return r.stdout;}
function evaluate(fn,arg){const output=cli('eval',`code=(${fn.toString()})(${JSON.stringify(arg)})`);const marker=output.lastIndexOf('=> ');if(marker<0)throw Error(output);return JSON.parse(output.slice(marker+3));}
function save(){writeFileSync(join(artifacts,'authority-app-proof.json'),JSON.stringify(report,null,2)+'\n');}
function step(name,result){report.steps.push({name,result});save();}
const identity={name:vault,path:expected};
async function bind(input){
  if(app.vault.getName()!==input.identity.name||app.vault.adapter.getBasePath()!==input.identity.path)throw Error('Wrong vault');
  const plugin=app.plugins.plugins.nexus,adapter=await plugin.getService('hybridStorageAdapter'),service=await plugin.getService('taskService');
  if(!await adapter.waitForQueryReady())throw Error('Storage not ready');
  let f=input.fixture;
  if(!f){const id=input.run;const p=await service.createProject('default',{name:'Authority QA P '+id}),q=await service.createProject('default',{name:'Authority QA Q '+id});f={p,q,t:await service.createTask(p,{title:'Authority QA unit '+id}),u:await service.createTask(q,{title:'Authority QA competitor '+id}),scope:'qa-'+id,authority:'qa-authority-'+id,human:'qa-human-'+id,host:'qa-host-'+id,cap:{id:'qa-lease-only',version:1,revision:1,hash:'1'.repeat(64)}};}
  const allowed=new Map([[f.p,f.t],[f.q,f.u]]),shared='file:'+f.scope+':Scratch/Shared.md';
  await service.configureTaskAuthority({protocol:'task-authority-config/v1',mode:'authority',vault_scope:f.scope,authority_id:f.authority,issuer_id:f.human,host_id:f.host,max_lease_ms:30000,eligible_project_ids:[f.p,f.q],selection_timeout_ms:30000,selectionValidator:async request=>{
    // Lease-only synthetic QA policy, never a productive capability resolver.
    const rank={critical:0,high:1,medium:2,low:3};
    const candidates=request.projects.flatMap(p=>p.source.tasks.filter(t=>allowed.get(p.source.project_id)===t.id&&['todo','in_progress'].includes(t.status)&&!p.coordination.resources.some(r=>r.state!=='free'&&(r.resource_id==='project:'+p.source.project_id||r.resource_id==='task:'+t.id))&&p.priority_evidence.some(v=>v.task_id===t.id&&v.evidence?.value===t.priority)).map(t=>({project_id:p.source.project_id,task_id:t.id,priority:t.priority,status:t.status,created:t.created})));
    candidates.sort((a,b)=>rank[a.priority]-rank[b.priority]||Number(a.status!=='in_progress')-Number(b.status!=='in_progress')||a.created-b.created||(a.project_id<b.project_id?-1:a.project_id>b.project_id?1:a.task_id<b.task_id?-1:a.task_id>b.task_id?1:0));
    const winner=candidates[0];return{protocol:'task-acquire-selection-decision/v1',snapshot_hash:request.snapshot_hash,selection:{protocol:'dream-priority-selection/v1',state:winner?'selected':'no_eligible_unit',selected_unit:winner?{project_id:winner.project_id,task_id:winner.task_id}:null,reason_refs:[],source_revisions:request.projects.map(p=>({project_id:p.source.project_id,revision:p.source.revision}))}};
  },bindHost:port=>{window.__authorityQAHost=port;},capabilityValidator:async(e,effect)=>{const task=allowed.get(e.project_id),c=e.command,ref=c.capability_ref||effect?.capabilityRef;if(!task||(c.task_id&&c.task_id!==task)||JSON.stringify(ref)!==JSON.stringify(f.cap))throw Error('Synthetic scope refused');return{resources:[shared,'project:'+e.project_id,'task:'+task].sort(),max_lease_ms:30000};},artifactValidator:async()=>{throw Error('External effects disabled in this QA');}});
  const a=service.getTaskAuthority();
  if(!input.fixture)for(const p of [f.p,f.q])await a.executeCommand({protocol:'task-authority-command/v1',vault_scope:f.scope,authority_id:f.authority,project_id:p,issuer_id:f.human,operation_id:'admit-'+p,expected_revision:0,command:{type:'admitProject',baseline_hash:await adapter.taskCoordination.currentHash(p)}});
  window.__authorityQA={adapter,service,fixture:f,shared};
  const agent=(await plugin.getService('agentManager')).getAgent('taskManager');
  if(agent.getTaskService()!==service)throw Error('MCP service not shared');
  return f;
}
async function kernel(){
  const {adapter,service,fixture:f,shared}=window.__authorityQA,a=service.getTaskAuthority(),checks=[];
  const query=p=>a.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:f.scope,authority_id:f.authority,project_id:p,issuer_id:f.human});
  const envelope=async(p,command,id)=>({protocol:'task-authority-command/v1',vault_scope:f.scope,authority_id:f.authority,project_id:p,issuer_id:f.human,operation_id:id,expected_revision:(await query(p)).revision,command});
  const assert=(value,name)=>{if(!value)throw Error(name);checks.push(name);};
  const refused=async(fn,code,name)=>{let actual;try{await fn();}catch(e){actual=e.message.split(':')[0];}assert(actual===code,name);};
  const acquire=(p,t)=>({type:'acquireUnit',task_id:t,resources:[shared,'project:'+p,'task:'+t].sort(),lease_ms:30000,capability_ref:f.cap});
  await refused(async()=>a.executeCommand(await envelope(f.p,acquire(f.p,f.t),'missing-priority')),'fence_rejected','No priority without authentic provenance');
  for(const[p,t]of[[f.p,f.t],[f.q,f.u]]){await service.updateTask(t,{priority:'high'});const proof=await window.__authorityQAHost.readPriorityEvidence({project_id:p,task_id:t});assert(proof?.value==='high'&&proof.source_issuer_id===f.human,'Canonical priority proof');}
  const staleSelection=await envelope(f.p,acquire(f.p,f.t),'selection-before-q-critical');
  await service.updateTask(f.u,{priority:'critical'});
  await refused(()=>a.executeCommand(staleSelection),'fence_rejected','Global priority revalidated despite unchanged selected-project revision');
  await service.updateTask(f.u,{priority:'high'});
  const source=await window.__authorityQAHost.readProjectSnapshot({project_id:f.p});assert(source.complete===true&&source.tasks.length===1&&source.tasks[0].id===f.t&&source.dependencies.length===0&&source.revision===(await query(f.p)).revision,'Complete source from real WASM at current revision');
  const commands=[await envelope(f.p,acquire(f.p,f.t),'acquire-p'),await envelope(f.q,acquire(f.q,f.u),'acquire-q')];
  const race=await Promise.allSettled(commands.map(e=>a.executeCommand(e))),wins=race.filter(r=>r.status==='fulfilled'),losses=race.filter(r=>r.status==='rejected');
  assert(wins.length===1&&losses.length===1&&losses[0].reason.message==='lease_busy','Cross-project exclusive shared resource');
  const lease=wins[0].value,t=lease.project_id===f.p?f.t:f.u,original=await adapter.tasks.getById(t);
  try{await refused(()=>service.updateTask(t,{title:'Forbidden'}),'lease_busy','Native facade refuses busy mutation');await refused(()=>adapter.tasks.update(t,{title:'Forbidden bypass'}),'protocol_incompatible','Repository refuses bypass');assert((await adapter.tasks.getById(t)).title===original.title,'Rejected writes preserve bytes');}
  finally{await a.executeCommand(await envelope(lease.project_id,{type:'releaseLease',lease_id:lease.lease_id,epoch:lease.epoch},'release'))}
  const create=await envelope(f.p,{type:'interactiveMutation',resources:['project:'+f.p],mutation:{kind:'createTask',arguments:{projectId:f.p,title:'Idempotent '+f.scope,priority:'medium'}}},'create-once');
  const first=await a.executeCommand(create),retry=await a.executeCommand(create);assert(JSON.stringify(first)===JSON.stringify(retry),'Idempotency before revision');
  assert((await service.listTasks(f.p,{page:0,pageSize:100})).items.filter(t=>t.id===first.entity_id).length===1,'One durable task');
  const changed=JSON.parse(JSON.stringify(create));changed.command.mutation.arguments.title='Changed payload';await refused(()=>a.executeCommand(changed),'operation_signature_conflict','Stable identity refuses changed payload');
  return{checks,receipt:first,status:await query(f.p)};
}
async function board(input){
  const {service,fixture:f,shared}=window.__authorityQA,a=service.getTaskAuthority();
  const base={protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:f.scope,authority_id:f.authority,project_id:f.p,issuer_id:f.human},status=await a.query(base);
  const lease=await a.executeCommand({protocol:'task-authority-command/v1',vault_scope:f.scope,authority_id:f.authority,project_id:f.p,issuer_id:f.human,operation_id:'board-lease',expected_revision:status.revision,command:{type:'acquireUnit',task_id:f.t,resources:[shared,'project:'+f.p,'task:'+f.t].sort(),lease_ms:30000,capability_ref:f.cap}});
  try{
    const view=app.workspace.getLeavesOfType('nexus-task-board')[0]?.view;if(!view||view.dataController.getTaskService()!==service)throw Error('Native board not shared');
    const task=await window.__authorityQA.adapter.tasks.getById(f.t);
    const button=Array.from(view.containerEl.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Edit '+task.title);if(!button)throw Error('QA card not rendered');button.click();
    const modal=document.querySelector('.nexus-task-edit-modal'),field=modal?.querySelector('input[placeholder="Task title"]');if(!field)throw Error('Editor missing');field.value='Unsaved '+f.scope;field.dispatchEvent(new Event('input',{bubbles:true}));modal.querySelector('button.mod-cta').click();
    for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,50));if(!modal.querySelector('button.mod-cta')?.disabled)break;}
    if(!document.contains(modal)||field.value!=='Unsaved '+f.scope||(await window.__authorityQA.adapter.tasks.getById(f.t)).title!==task.title)throw Error('Busy save lost draft or changed task');
    return{draft_preserved:true,original_title:task.title,shared_factory:true};
  }finally{const modal=document.querySelector('.nexus-task-edit-modal');Array.from(modal?.querySelectorAll('button')||[]).find(b=>b.textContent==='Cancel')?.click();const q=await a.query(base);await a.executeCommand({protocol:'task-authority-command/v1',vault_scope:f.scope,authority_id:f.authority,project_id:f.p,issuer_id:f.human,operation_id:'board-release',expected_revision:q.revision,command:{type:'releaseLease',lease_id:lease.lease_id,epoch:lease.epoch}});}
}
try{
  const probe=evaluate(()=>({name:app.vault.getName(),path:app.vault.adapter.getBasePath()}));if(JSON.stringify(probe)!==JSON.stringify(identity))throw Error('Wrong vault identity');
  const main=readFileSync(join(expected,'.obsidian/plugins/nexus/main.js'));report.installed_main_sha256=createHash('sha256').update(main).digest('hex');save();
  cli('plugin:reload','id=nexus');
  const fixture=evaluate(bind,{identity,run:report.run_id});report.fixture=fixture;save();step('real kernel',evaluate(kernel));
  cli('command','id=nexus:open-task-board');step('real board',evaluate(board));
  cli('plugin:reload','id=nexus');evaluate(bind,{identity,fixture});
  const query={protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:fixture.scope,authority_id:fixture.authority,project_id:fixture.p,issuer_id:fixture.human};
  const queryPath=join(artifacts,'coordination-query.json');writeFileSync(queryPath,JSON.stringify(query));
  const discovery=spawnSync('nexus',['--vault',vault,'tools','task coordination-status'],{encoding:'utf8',timeout:30000});if(discovery.status!==0)throw Error(discovery.stdout+discovery.stderr);
  const status=spawnSync('nexus',['use','--vault',vault,'--session','Authority QA '+fixture.scope,'--workspace','default','--memory','Synthetic authority application qualification after restart.','--goal','Read actual public coordination state without replaying effects.','--','task','coordination-status','--envelope-file',queryPath],{encoding:'utf8',timeout:30000});
  if(status.status!==0)throw Error(status.stdout+status.stderr);const publicResult=JSON.parse(status.stdout);if(!publicResult.success||publicResult.result.epoch!==2)throw Error(status.stdout);step('public CLI after restart',publicResult);
  const receipt=evaluate(async()=>{const{service,fixture:f}=window.__authorityQA;return service.getTaskAuthority().query({protocol:'task-authority-query/v1',type:'getOperation',vault_scope:f.scope,authority_id:f.authority,project_id:f.p,issuer_id:f.human,operation_id:'create-once'});});
  if(receipt.result?.entity_id!==report.steps[0].result.receipt.entity_id)throw Error('Receipt changed across restart');step('durable receipt after restart',receipt);
  step('real WASM cache reconstruction',evaluate(async()=>{
    const c=window.__authorityQA,f=c.fixture,a=c.service.getTaskAuthority(),query={protocol:'task-authority-query/v1',type:'getOperation',vault_scope:f.scope,authority_id:f.authority,project_id:f.p,issuer_id:f.human,operation_id:'create-once'};
    const before=await a.query(query),suspension=await c.service.suspendTaskAuthority();await c.adapter.rebuildCache();
    const after=await a.query(query),source=await window.__authorityQAHost.readProjectSnapshot({project_id:f.p});let error;try{await c.service.updateTask(f.t,{title:'Forbidden while suspended'});}catch(e){error=e.message;}
    if(JSON.stringify(before)!==JSON.stringify(after)||source.tasks.length!==2||error!=='authority_unavailable')throw Error('Rebuild lost receipt/source or bypassed suspension');
    return{suspension,receipt:after,source_revision:source.revision,task_count:source.tasks.length,suspended_mutation_error:error};
  }));
  report.state='passed';report.finished_at=new Date().toISOString();save();console.log(JSON.stringify({state:report.state,proof:join(artifacts,'authority-app-proof.json')}));
}catch(error){report.state='failed';report.error=String(error);save();console.error(error);process.exitCode=1;}
