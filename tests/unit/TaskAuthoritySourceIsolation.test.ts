import * as fs from 'node:fs';
import * as path from 'node:path';
import {fixture,fixtureSelection} from '../helpers/taskAuthorityFixture';
import {TaskAuthorityRuntime} from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';
const hash='a'.repeat(64),capability_ref={id:'cap',version:1,revision:1,hash};
it.each([{authority_id:'b',vault_scope:'v'},{authority_id:'a',vault_scope:'other-v'}])('permits one active authority writer per physical storage: %j',async scope=>{
 const f=await fixture();const other=new TaskAuthorityRuntime({...f.storage});try{
  await f.admit();const root=path.join(f.directory,'Store/data/task-authority');
  const journals=()=>fs.readdirSync(root,{recursive:true}).filter(x=>String(x).endsWith('.jsonl')).map(x=>[String(x),fs.readFileSync(path.join(root,String(x)),'utf8')]);
  const before=journals();await expect(other.configure({...f.config,...scope,bindHost:undefined})).rejects.toThrow();expect(journals()).toEqual(before);
  await f.runtime.close();await other.configure({...f.config,...scope,bindHost:undefined});
  await expect(other.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',...scope,project_id:'p',issuer_id:'human'})).rejects.toThrow('fence_rejected');
 }finally{await other.close();await f.cleanup();}
});
it('serializes close and reconfiguration behind an in-flight selection callback',async()=>{
 const f=await fixture();try{
  await f.admit();await f.service.updateTask('t',{priority:'high'});
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
  await f.runtime.configure({...f.config,selectionValidator:async request=>{enter();await gate;return fixtureSelection(request);}});
  const acquiring=f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources:['project:p','task:t'],lease_ms:1000,capability_ref}));await entered;
  const closing=f.runtime.close(),configuring=f.runtime.configure(f.config);release();await acquiring;await closing;await configuring;
  expect(await f.runtime.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human'})).toMatchObject({admitted:true});
  await expect(f.runtime.executeCommand(await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'after restart'}}}))).rejects.toThrow('lease_busy');
 }finally{await f.cleanup();}
});
it('rejects a request queued under a replaced configuration',async()=>{
 const f=await fixture();try{
  await f.admit();await f.service.updateTask('t',{priority:'high'});
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
  await f.runtime.configure({...f.config,selectionValidator:async request=>{enter();await gate;return fixtureSelection(request);}});
  const acquiring=f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources:['project:p','task:t'],lease_ms:1000,capability_ref}));await entered;
  const configuring=f.runtime.configure(f.config);
  // Allow lifecycle scheduling to enqueue configure before the old request.
  await Promise.resolve();await Promise.resolve();
  const stale=f.runtime.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human'});
  const rejected=expect(stale).rejects.toThrow('authority_unavailable');release();await acquiring;await configuring;await rejected;
 }finally{await f.cleanup();}
});
