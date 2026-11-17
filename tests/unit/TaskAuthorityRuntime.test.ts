import { normalizeCommand, normalizeQuery } from '../../src/agents/taskManager/authority/TaskAuthorityContracts';
const hash = 'a'.repeat(64);
const envelope = { protocol: 'task-authority-command/v1', vault_scope: 'v', authority_id: 'a', project_id: 'p', issuer_id: 'i', operation_id: 'o', expected_revision: 0 };
describe('task authority closed contracts', () => {
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
