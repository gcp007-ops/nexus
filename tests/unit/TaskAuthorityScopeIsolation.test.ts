import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskAuthorityRuntime, type TaskAuthorityHostPort } from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';

const hash='a'.repeat(64);
describe('authority ownership across succession on real SQL and journal',()=>{
  it.each([{vault_scope:'v',authority_id:'b'},{vault_scope:'other-v',authority_id:'a'}])('fences a project owned by another scope: %j',async scope=>{
    const f=await fixture();let next:TaskAuthorityRuntime|undefined;
    try{
      const admitted=await f.admit() as {operation_id:string};
      await f.service.updateTask('t',{priority:'high'});
      const resources=['project:p','repository_directory:repo:src','task:t'],capability_ref={id:'cap',version:1,revision:1,hash};
      const lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref})) as any;
      const dispatch=await f.runtime.executeCommand(await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'effect',resources,capability_ref,precondition_hash:hash,proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash})) as any;
      await f.host.executeCommand(await f.command('p',{type:'beginEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',lease_id:lease.lease_id,epoch:lease.epoch,host_id:'host',proposal_hash:hash}));
      await f.host.executeCommand(await f.command('p',{type:'recordEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',receipt_ref:{artifact_id:'receipt',hash},receipt_hash:hash,result:'applied'}));
      await f.runtime.close();next=new TaskAuthorityRuntime(f.storage);let host!:TaskAuthorityHostPort;
      await next.configure({...f.config,...scope,eligible_project_ids:scope.vault_scope==='v'?['q']:['p','q'],closure_timeout_ms:10000,closureValidator:async r=>({protocol:'task-closure-authorization/v1',authorized:true,step:r.step,criteria_ref:{artifact_id:hash,hash},allow_physical_deferred:true}),bindHost:(p:TaskAuthorityHostPort)=>{host=p;}});
      const beforeState=await f.cache.query('SELECT * FROM task_coordination_state');
      const beforeTasks=await f.cache.query('SELECT * FROM tasks');
      const beforeEvents=await f.cache.query('SELECT * FROM applied_events');
      const beforeReceipts=await f.cache.query('SELECT * FROM task_coordination_receipts');
      const journalRoot=path.join(f.directory,'Store/data/task-authority');
      const journals=()=>fs.readdirSync(journalRoot,{recursive:true}).filter(x=>String(x).endsWith('.jsonl')).map(x=>[String(x),fs.readFileSync(path.join(journalRoot,String(x)),'utf8')]);
      const beforeJournals=journals();
      const query={protocol:'task-authority-query/v1',...scope,project_id:'p',issuer_id:'human'};
      await expect(next.query({...query,type:'getProjectCoordination'})).rejects.toThrow('fence_rejected');
      await expect(next.query({...query,type:'getOperation',operation_id:admitted.operation_id})).rejects.toThrow('fence_rejected');
      const command=await f.command('p',{type:'interactiveMutation',resources,mutation:{kind:'updateTask',arguments:{taskId:'t',title:'foreign'}}},{...scope});
      await expect(next.executeCommand(command)).rejects.toThrow('fence_rejected');
      await expect(next.executeCommand(await f.command('p',{type:'admitProject',baseline_hash:await f.repository.currentHash('p')},{...scope}))).rejects.toThrow('fence_rejected');
      await expect(host.readProjectSnapshot({project_id:'p'})).rejects.toThrow('fence_rejected');
      await expect(host.readEffectEvidence({project_id:'p',effect_id:'effect',dispatch_id:dispatch.dispatch_id})).rejects.toThrow('fence_rejected');
      await expect(host.readProgressConsumption({project_id:'p',effect_id:'effect',dispatch_id:dispatch.dispatch_id})).rejects.toThrow('fence_rejected');
      await expect(host.readClosure({project_id:'p',closure_id:'c'})).rejects.toThrow('fence_rejected');
      await expect(host.readPriorityEvidence({project_id:'p',task_id:'t'})).rejects.toThrow('fence_rejected');
      await expect(next.isAdmitted('p')).rejects.toThrow('fence_rejected');
      await expect(next.routeInteractiveMutation({projectId:'p',mutation:{kind:'updateTask',arguments:{taskId:'t',title:'foreign'}}})).rejects.toThrow('fence_rejected');
      await expect(host.releaseCommittedLease({project_id:'p',effect_id:'effect',dispatch_id:dispatch.dispatch_id,commit_operation_id:'commit',commit_operation_signature:hash,operation_id:'release'})).rejects.toThrow('fence_rejected');
      await expect(host.cancelDispatchedEffect({project_id:'p',effect_id:'effect',dispatch_id:dispatch.dispatch_id,operation_id:'cancel',proof_ref:{artifact_id:'proof',hash}})).rejects.toThrow('fence_rejected');
      await expect(host.closureCommand({protocol:'task-closure-command/v1',...scope,project_id:'p',issuer_id:'host',operation_id:'closure',expected_revision:6,command:{type:'acquireClosure',closure_id:'closure',initiative_id:'initiative',criteria_ref:{artifact_id:hash,hash},step:'gate_confirmed',capability_ref,resources:['project:p'],lease_ms:1000}})).rejects.toThrow('fence_rejected');
      await expect(host.recoverConfirmedEffect({project_id:'p',effect_id:'effect',dispatch_id:dispatch.dispatch_id,operation_id:'recovery',proof_ref:{artifact_id:'proof',hash},lease_ms:1000})).rejects.toThrow('fence_rejected');
      expect(await f.cache.query('SELECT * FROM task_coordination_state')).toEqual(beforeState);
      expect(await f.cache.query('SELECT * FROM task_coordination_receipts')).toEqual(beforeReceipts);
      expect(await f.cache.query('SELECT * FROM tasks')).toEqual(beforeTasks);
      expect(await f.cache.query('SELECT * FROM applied_events')).toEqual(beforeEvents);
      expect(journals()).toEqual(beforeJournals);
      await next.executeCommand(await f.command('q',{type:'admitProject',baseline_hash:await f.repository.currentHash('q')},{...scope}));
      await next.routeInteractiveMutation({projectId:'q',mutation:{kind:'updateTask',arguments:{taskId:'x',priority:'high'}}});
      await expect(next.executeCommand(await f.command('q',{type:'acquireUnit',task_id:'x',resources:['project:q','repository_file:repo:src/main.ts','task:x'],lease_ms:1000,capability_ref},{...scope}))).rejects.toThrow('lease_busy');
    }finally{await next?.close();await f.cleanup();}
  });
});
