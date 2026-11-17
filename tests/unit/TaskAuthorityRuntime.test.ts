import { normalizeCommand, normalizeQuery, taskAuthorityEnvelopeSchema } from '../../src/agents/taskManager/authority/TaskAuthorityContracts';
const hash = 'a'.repeat(64);
const envelope = { protocol: 'task-authority-command/v1', vault_scope: 'v', authority_id: 'a', project_id: 'p', issuer_id: 'i', operation_id: 'o', expected_revision: 0 };
describe('task authority closed contracts', () => {
  it('advertises query envelopes as objects for CLI file transport', () => {
    expect(taskAuthorityEnvelopeSchema(true)).toMatchObject({ type: 'object' });
  });
  it('accepts the command variants with all required fields', () => {
    const capability_ref = { id: 'c', version: 1, revision: 1, hash };
    const resources = ['project:p', 'task:t'];
    const commands = [
      { type: 'admitProject', baseline_hash: hash },
      { type: 'acquireUnit', task_id: 't', resources, lease_ms: 5, capability_ref },
      { type: 'renewLease', lease_id: 'l', epoch: 0, lease_ms: 5 },
      { type: 'releaseLease', lease_id: 'l', epoch: 0 },
      { type: 'dispatchEffect', lease_id: 'l', epoch: 0, effect_id: 'e', capability_ref, resources, precondition_hash: hash, proposal_ref: { artifact_id: 'r', hash }, proposal_hash: hash },
      { type: 'beginEffect', dispatch_id: 'd', effect_id: 'e', lease_id: 'l', epoch: 0, host_id: 'h', proposal_hash: hash },
      { type: 'recordEffect', dispatch_id: 'd', effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, receipt_hash: hash, result: 'applied' },
      { type: 'commitProgress', lease_id: 'l', epoch: 0, effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, task_id: 't', expected_status: 'todo', next_status: 'in_progress', evidence_refs: [{ artifact_id: 'e', hash }] },
      { type: 'interactiveMutation', resources, mutation: { kind: 'moveTask', arguments: { taskId: 't', parentTaskId: null } } },
    ];
    for (const command of commands) expect(normalizeCommand({ ...envelope, command })).toBeDefined();
  });
  it('rejects extra keys, invalid hashes, invalid resources and forged metadata', () => {
    for (const command of [
      { type: 'admitProject', baseline_hash: hash, unexpected: true },
      { type: 'admitProject', baseline_hash: 'short' },
      { type: 'acquireUnit', task_id: 't', resources: ['task:t', 'project:p'], lease_ms: 5, capability_ref: { id: 'c', version: 1, revision: 1, hash } },
      { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', metadata: { dream_priority_v1: {} } } } },
      { type: 'commitProgress', lease_id: 'l', epoch: 0, effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, task_id: 't', expected_status: 'todo', next_status: 'done', evidence_refs: [{ artifact_id: 'e', hash }] },
    ]) expect(() => normalizeCommand({ ...envelope, command })).toThrow();
    expect(() => normalizeCommand({ ...envelope, extra: 1, command: { type: 'admitProject', baseline_hash: hash } })).toThrow();
  });
  it('rejects attempts to remove reserved derived metadata', () => {
    const command = { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', removeMetadataKeys: ['dream_priority_v1'] } } };
    expect(() => normalizeCommand({ ...envelope, command })).toThrow();
  });
  it('rejects noncanonical file resources', () => {
    const capability_ref = { id: 'c', version: 1, revision: 1, hash };
    for (const resource of ['file:v:../escape', 'file:v:/absolute', 'file:v:a/../b', 'file:v:a//b']) {
      expect(() => normalizeCommand({ ...envelope, command: { type: 'acquireUnit', task_id: 't', resources: [resource], lease_ms: 5, capability_ref } })).toThrow();
    }
  });
  it('copies caller data and preserves ordinary JSON metadata', () => {
    const input = { ...envelope, command: { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', metadata: { receipt: null } } } } };
    const result = normalizeCommand(input);
    input.command.mutation.arguments.taskId = 'changed';
    expect(JSON.stringify(result)).toContain('\"taskId\":\"t\"');
  });
  it('accepts exact query types and rejects unknown fields', () => {
    const query = { protocol: 'task-authority-query/v1', vault_scope: 'v', authority_id: 'a', project_id: 'p', issuer_id: 'i' };
    expect(normalizeQuery({ ...query, type: 'getOperation', operation_id: 'o' })).toBeDefined();
    expect(normalizeQuery({ ...query, type: 'getProjectCoordination' })).toBeDefined();
    expect(() => normalizeQuery({ ...query, type: 'getProjectCoordination', operation_id: 'o' })).toThrow();
  });
});

import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskAuthorityRuntime, getTaskAuthorityRuntime } from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';
const cap = {id:'cap',version:1,revision:1,hash};
describe('complete authoritative project source',()=>{
  it('returns all native tasks and dependency edges beyond legacy pagination',async()=>{const f=await fixture();try{
    const insert=f.cache.db.prepare("INSERT INTO tasks(id,projectId,workspaceId,title,status,priority,created,updated) VALUES (?,'p','w',?,'todo','medium',1,1)");
    for(let n=0;n<10001;n++)insert.run('bulk-'+n,'bulk-'+n);
    await f.cache.run("INSERT INTO task_dependencies VALUES ('t','bulk-10000',1)");await f.admit();
    const source=await f.host.readProjectSnapshot({project_id:'p'});
    expect(source).toMatchObject({protocol:'task-project-source/v1',complete:true,revision:1,project:{id:'p',workspaceId:'w',status:'active'},dependencies:[{taskId:'t',dependsOnTaskId:'bulk-10000'}]});expect(source.tasks).toHaveLength(10003);expect(source.tasks.some(t=>t.id==='bulk-10000')).toBe(true);
    await f.service.updateTask('t',{title:'New authoritative revision'});const next=await f.host.readProjectSnapshot({project_id:'p'});expect(next.revision).toBe(2);expect(next.operational_hash).not.toBe(source.operational_hash);
  }finally{await f.cleanup();}});
  it('refuses a projection that diverges from the canonical operational hash',async()=>{const f=await fixture();try{await f.admit();await f.cache.run("UPDATE tasks SET title='Unrecorded' WHERE id='t'");await expect(f.host.readProjectSnapshot({project_id:'p'})).rejects.toThrow();}finally{await f.cleanup();}});
});
describe('authority state machine with real disk and SQL',()=>{
  it('shares runtime by storage identity and excludes a second activating runtime',async()=>{
    const f=await fixture();try{expect(getTaskAuthorityRuntime(f.storage)).toBe(getTaskAuthorityRuntime(f.storage));const second=new TaskAuthorityRuntime(f.storage);await expect(second.configure(f.config)).rejects.toThrow();await f.admit();expect(await f.repository.isAdmitted('p')).toBe(true);}finally{await f.cleanup();}
  });
  it('serializes concurrent CAS and returns one durable winner',async()=>{
    const f=await fixture();try{await f.admit();await f.service.updateTask('t',{priority:'high'});const body={type:'acquireUnit',task_id:'t',resources:['project:p','task:t'],lease_ms:1000,capability_ref:cap};const a=await f.command('p',body);const b=await f.command('p',body);const results=await Promise.allSettled([f.runtime.executeCommand(a),f.runtime.executeCommand(b)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);expect(await f.repository.getState('p')).toMatchObject({revision:3});}finally{await f.cleanup();}
  });
  it('keeps an in-flight repository directory reserved globally after lease expiry',async()=>{
    const f=await fixture();try{
      await f.admit();await f.admit('q');const resources=['project:p','repository_directory:repo:src','task:t'];
      await f.service.updateTask('t',{priority:'high'});await f.service.updateTask('x',{priority:'high'});
      const realNow=Date.now; const now=realNow();
      const lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
      const dispatch=await f.runtime.executeCommand(await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'e',capability_ref:cap,resources,precondition_hash:await f.repository.currentHash('p'),proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash})) as Record<string,unknown>;
      await f.host.executeCommand(await f.command('p',{type:'beginEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'e',dispatch_id:dispatch.dispatch_id,host_id:'host',proposal_hash:hash}));
      Date.now=()=>now+20000;
      try{await expect(f.runtime.executeCommand(await f.command('q',{type:'acquireUnit',task_id:'x',resources:['project:q','repository_file:repo:src/main.ts','task:x'],lease_ms:1000,capability_ref:cap}))).rejects.toThrow('lease_busy');}finally{Date.now=realNow;}
      const suspended=await f.runtime.suspend();expect(suspended.pending_operation_ids).toHaveLength(1);
      await expect(f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap}))).rejects.toThrow('authority_unavailable');
      await f.host.executeCommand(await f.command('p',{type:'recordEffect',dispatch_id:dispatch.dispatch_id,effect_id:'e',receipt_ref:{artifact_id:'receipt',hash},receipt_hash:hash,result:'applied'}));
      const status=await f.runtime.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human'});expect(status).toMatchObject({admitted:true});
    }finally{await f.cleanup();}
  });
  it('refuses malformed repository resource identities',()=>{
    for(const resource of ['repository_file:r:/absolute','repository_directory:r:a/../b','repository_file:r:a\\b','repository_file:r:a//b','repository_file:r:C:/x'])expect(()=>normalizeCommand({...envelope,command:{type:'acquireUnit',task_id:'t',resources:[resource],lease_ms:1,capability_ref:cap}})).toThrow('invalid_command');
  });
});

describe('authenticated host readback and recovery',()=>{
  it('rejects a forged host issuer on the public/MCP ingress before recording a transition',async()=>{const f=await fixture();try{await f.admit();const before=await f.repository.getState('p');await expect(f.runtime.executeCommand(await f.command('p',{type:'beginEffect',dispatch_id:'d',effect_id:'e',lease_id:'l',epoch:1,host_id:'host',proposal_hash:hash}))).rejects.toThrow('unauthorized');expect(await f.repository.getState('p')).toEqual(before);}finally{await f.cleanup();}});
  it('requires authenticated priority provenance and preserves it through metadata replacement',async()=>{const f=await fixture();try{await f.admit();const acquire={type:'acquireUnit',task_id:'t',resources:['project:p','task:t'],lease_ms:1000,capability_ref:cap};await expect(f.runtime.executeCommand(await f.command('p',acquire))).rejects.toThrow('fence_rejected');await f.service.updateTask('t',{priority:'high'});await f.service.updateTask('t',{metadataMode:'replace',metadata:{ordinary:'value'}});expect(await f.runtime.executeCommand(await f.command('p',acquire))).toMatchObject({status:'acquired'});const row=await f.cache.queryOne<{metadataJson:string}>('SELECT metadataJson FROM tasks WHERE id=?',['t']);expect(JSON.parse(row!.metadataJson)).toMatchObject({ordinary:'value',dream_priority_v1:{value:'high'}});}finally{await f.cleanup();}});
  it('links the canonical receipt and recovers only consumption after restart/expiry',async()=>{
    const f=await fixture();let restarted:TaskAuthorityRuntime|undefined;try{
      await f.admit();await f.service.updateTask('t',{priority:'high'});const resources=['project:p','task:t'];const lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
      const dispatch=await f.runtime.executeCommand(await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'effect',resources,capability_ref:cap,precondition_hash:'b'.repeat(64),proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash})) as Record<string,unknown>;
      await f.host.executeCommand(await f.command('p',{type:'beginEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',lease_id:lease.lease_id,epoch:lease.epoch,host_id:'host',proposal_hash:hash}));
      const record=await f.command('p',{type:'recordEffect',dispatch_id:dispatch.dispatch_id,effect_id:'effect',receipt_ref:{artifact_id:'receipt',hash},receipt_hash:hash,result:'applied'});await f.host.executeCommand(record);
      const evidence=await f.service.getTaskAuthority().readEffectEvidence({project_id:'p',effect_id:'effect',dispatch_id:String(dispatch.dispatch_id)});expect(evidence).toMatchObject({protocol:'task-effect-verification/v1',state:'confirmed',record_operation_id:record.operation_id,receipt_ref:{artifact_id:'receipt',hash},receipt_hash:hash,precondition_hash:'b'.repeat(64)});expect((evidence as {record_operation_signature:string}).record_operation_signature).toMatch(/^[a-f0-9]{64}$/);
      const oldHost=f.host;await f.runtime.close();restarted=new TaskAuthorityRuntime(f.storage);await restarted.configure(f.config);
      const recovery={project_id:'p',effect_id:'effect',dispatch_id:String(dispatch.dispatch_id),operation_id:'recover-only-consumption',proof_ref:{artifact_id:'quiescence-proof',hash},lease_ms:1000};const recovered=await f.host.recoverConfirmedEffect(recovery) as Record<string,unknown>;expect(recovered).toMatchObject({status:'acquired',epoch:2});expect(await f.host.recoverConfirmedEffect(recovery)).toEqual(recovered);
      const commit=await f.command('p',{type:'commitProgress',lease_id:recovered.lease_id,epoch:recovered.epoch,effect_id:'effect',receipt_ref:{artifact_id:'receipt',hash},task_id:'t',expected_status:'todo',next_status:'in_progress',evidence_refs:[{artifact_id:'proof',hash}]});expect(await restarted.executeCommand(commit)).toMatchObject({status:'committed',effect_id:'effect',task_id:'t'});expect(await f.cache.queryOne('SELECT status FROM tasks WHERE id=?',['t'])).toEqual({status:'in_progress'});
      // A reconfiguration of the SAME runtime invalidates already handed-out
      // host closures for new acts. A retired runtime remains unavailable too.
      await expect(oldHost.executeCommand(record)).rejects.toThrow('authority_unavailable');
    }finally{await restarted?.close();await f.cleanup();}
  });
});

it('refuses reusing an effect identity in another project of the same authority',async()=>{const f=await fixture();try{await f.admit();await f.admit('q');await f.service.updateTask('t',{priority:'high'});await f.service.updateTask('x',{priority:'high'});for(const [project,task] of [['p','t'],['q','x']]){const resources=[`project:${project}`,`task:${task}`];const lease=await f.runtime.executeCommand(await f.command(project,{type:'acquireUnit',task_id:task,resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;const dispatch=f.runtime.executeCommand(await f.command(project,{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'globally-unique',resources,capability_ref:cap,precondition_hash:hash,proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash}));if(project==='p')expect(await dispatch).toMatchObject({status:'dispatched'});else await expect(dispatch).rejects.toThrow('fence_rejected');}}finally{await f.cleanup();}});


it('returns canonical priority provenance to the bound host even for a blocked task',async()=>{const f=await fixture();try{await f.admit();expect(await f.host.readPriorityEvidence({project_id:'p',task_id:'t'})).toBeNull();await f.service.updateTask('t',{priority:'critical'});await f.runtime.routeInteractiveMutation({projectId:'p',mutation:{kind:'updateTask',arguments:{taskId:'t',addDependencies:['u']}}});const evidence=await f.host.readPriorityEvidence({project_id:'p',task_id:'t'});expect(evidence).toMatchObject({protocol:'task-priority-verification/v1',value:'critical',source_issuer_id:'human',task_id:'t'});expect(evidence?.operation_signature).toMatch(/^[a-f0-9]{64}$/);await expect(f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources:['project:p','task:t'],lease_ms:1000,capability_ref:cap}))).rejects.toThrow('fence_rejected');}finally{await f.cleanup();}});
