import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskAuthorityRuntime } from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';
const hash='a'.repeat(64), cap={id:'cap',version:1,revision:1,hash};

describe('committed lease release',()=>{
  it('releases an old epoch only from a canonical commit, with durable idempotency',async()=>{
    const f=await fixture();let restarted:TaskAuthorityRuntime|undefined;try{
      await f.admit();await f.service.updateTask('t',{priority:'high'});
      const resources=['project:p','task:t'];
      const lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
      const dispatch=await f.runtime.executeCommand(await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'effect',resources,capability_ref:cap,precondition_hash:hash,proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash})) as Record<string,unknown>;
      await f.host.executeCommand(await f.command('p',{type:'beginEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',lease_id:lease.lease_id,epoch:lease.epoch,host_id:'host',proposal_hash:hash}));
      await f.host.executeCommand(await f.command('p',{type:'recordEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',receipt_ref:{artifact_id:'receipt',hash},receipt_hash:hash,result:'applied'}));
      const basic={project_id:'p',effect_id:'effect',dispatch_id:String(dispatch.dispatch_id),commit_operation_id:'missing',commit_operation_signature:hash,operation_id:'release'};
      await expect(f.host.releaseCommittedLease(basic)).rejects.toThrow('fence_rejected');
      const commit=await f.command('p',{type:'commitProgress',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'effect',receipt_ref:{artifact_id:'receipt',hash},task_id:'t',expected_status:'todo',next_status:'in_progress',evidence_refs:[{artifact_id:'proof',hash}]});
      await f.runtime.executeCommand(commit);
      const consumed=await f.host.readProgressConsumption({project_id:'p',effect_id:'effect',dispatch_id:String(dispatch.dispatch_id)});expect(consumed).not.toBeNull();
      const input={...basic,commit_operation_id:String(commit.operation_id),commit_operation_signature:consumed!.binding.commit_operation_signature};
      await expect(f.host.releaseCommittedLease({...input,commit_operation_signature:hash})).rejects.toThrow('fence_rejected');
      await expect(f.host.releaseCommittedLease({...input,dispatch_id:'forged'})).rejects.toThrow('fence_rejected');
      await f.admit('q');await f.service.updateTask('x',{priority:'high'});
      const other=await f.runtime.executeCommand(await f.command('q',{type:'acquireUnit',task_id:'x',resources:['project:q','task:x'],lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
      const previousPort=f.host;await f.runtime.configure(f.config);await expect(async()=>previousPort.releaseCommittedLease(input)).rejects.toThrow('unauthorized');
      const oldPort=f.host;await f.runtime.close();restarted=new TaskAuthorityRuntime(f.storage);await restarted.configure(f.config);
      await expect(oldPort.releaseCommittedLease(input)).rejects.toThrow();
      await restarted.suspend();const released=await f.host.releaseCommittedLease(input);expect(released).toMatchObject({status:'released',issuer_id:'host'});
      expect((await f.repository.getState('p'))!.leases[String(lease.lease_id)]).toBeUndefined();
      expect((await f.repository.getState('q'))!.leases[String(other.lease_id)]).toBeDefined();
      expect(await restarted.query({protocol:'task-authority-query/v1',type:'getOperation',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'host',operation_id:input.operation_id},'host')).toMatchObject({state:'committed',result:released});
      expect(await f.host.releaseCommittedLease({...input,operation_id:'already-absent'})).toMatchObject({status:'released'});
      expect(await f.host.releaseCommittedLease(input)).toEqual(released);
      await expect(f.host.releaseCommittedLease({...input,effect_id:'other'})).rejects.toThrow('operation_signature_conflict');
      await restarted.close();restarted=new TaskAuthorityRuntime(f.storage);await restarted.configure(f.config);
      expect(await f.host.releaseCommittedLease(input)).toEqual(released);
      expect(await f.cache.queryOne('SELECT status FROM tasks WHERE id=?',['t'])).toEqual({status:'in_progress'});
    }finally{await restarted?.close();await f.cleanup();}
  });
});
