import {fixture} from '../helpers/taskAuthorityFixture';
import {TaskAuthorityRuntime} from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';
const hash='a'.repeat(64),cap={id:'cap',version:1,revision:1,hash};
async function dispatched(f:Awaited<ReturnType<typeof fixture>>) {
  await f.admit();await f.service.updateTask('t',{priority:'high'});const resources=['project:p','task:t'];
  const lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
  const effect=await f.runtime.executeCommand(await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'cancel-unit',resources,capability_ref:cap,precondition_hash:hash,proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash})) as Record<string,unknown>;
  return {lease,effect,begin:await f.command('p',{type:'beginEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'cancel-unit',dispatch_id:effect.dispatch_id,host_id:'host',proposal_hash:hash})};
}
it('rechecks lease time after asynchronous begin validation',async()=>{
  const f=await fixture();let expire=false;const originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
  try{await f.runtime.configure({...f.config,artifactValidator:async()=>{if(expire)clock+=20000;return true;}});const d=await dispatched(f);expire=true;await expect(f.host.executeCommand(d.begin)).rejects.toThrow('stale_epoch');expect((await f.repository.getState('p'))?.effects['cancel-unit'].state).toBe('dispatched');}
  finally{Date.now=originalNow;await f.cleanup();}
});
const proof_ref={artifact_id:'cancel-proof',hash};
const validator=async(request:{proof_ref:unknown;effect:{resources:string[]}})=>({protocol:'task-dispatch-cancellation-proof/v1',proof_ref:request.proof_ref,quiescence_ref:{artifact_id:'finished-prepare',hash},resources:request.effect.resources});
it.each(['expired','suspended'])('refuses dispatch when validation crosses the %s boundary',async boundary=>{
 const f=await fixture();const originalNow=Date.now;let clock=originalNow(),cross=false;Date.now=()=>clock;
 try{await f.runtime.configure({...f.config,artifactValidator:async()=>{if(cross){if(boundary==='expired')clock+=20000;else void f.runtime.suspend();}return true;}});
  await f.admit();await f.service.updateTask('t',{priority:'high'});const resources=['project:p','task:t'],lease=await f.runtime.executeCommand(await f.command('p',{type:'acquireUnit',task_id:'t',resources,lease_ms:1000,capability_ref:cap})) as Record<string,unknown>;
  const command=await f.command('p',{type:'dispatchEffect',lease_id:lease.lease_id,epoch:lease.epoch,effect_id:'too-late',resources,capability_ref:cap,precondition_hash:hash,proposal_ref:{artifact_id:'proposal',hash},proposal_hash:hash});cross=true;
  await expect(f.runtime.executeCommand(command)).rejects.toThrow(boundary==='expired'?'stale_epoch':'authority_unavailable');expect((await f.repository.getState('p'))?.effects['too-late']).toBeUndefined();
 }finally{Date.now=originalNow;await f.cleanup();}
});
it('cancels only a never-started dispatch, records once and preserves it after replay',async()=>{
  const f=await fixture();let next:TaskAuthorityRuntime|undefined;
  try{const config={...f.config,cancelDispatchedValidator:validator,cancel_dispatched_timeout_ms:1000};await f.runtime.configure(config);const d=await dispatched(f);await f.runtime.suspend();
    const input={project_id:'p',effect_id:'cancel-unit',dispatch_id:d.effect.dispatch_id,operation_id:'cancel-once',proof_ref};
    const host=f.host as unknown as {cancelDispatchedEffect(input:unknown):Promise<unknown>};
    const result=await host.cancelDispatchedEffect(input);expect(result).toMatchObject({status:'failed',effect_id:'cancel-unit'});expect(await host.cancelDispatchedEffect(input)).toEqual(result);await expect(host.cancelDispatchedEffect({...input,proof_ref:{...proof_ref,hash:'b'.repeat(64)}})).rejects.toThrow('operation_signature_conflict');
    const state=await f.repository.getState('p');expect(state?.effects['cancel-unit'].state).toBe('failed');expect(Object.keys(state!.leases)).toHaveLength(0);
    await f.runtime.close();next=new TaskAuthorityRuntime(f.storage);await next.configure(config);expect(await (f.host as unknown as typeof host).cancelDispatchedEffect(input)).toEqual(result);
    await expect(f.host.executeCommand(d.begin)).rejects.toThrow();
  }finally{await next?.close();await f.cleanup();}
});
it('invalidates an old host port while allowing current recovery of an old dispatch',async()=>{
  const f=await fixture();try{const config={...f.config,cancelDispatchedValidator:validator,cancel_dispatched_timeout_ms:1000};await f.runtime.configure(config);const d=await dispatched(f),old=f.host as unknown as {cancelDispatchedEffect(input:unknown):Promise<unknown>},input={project_id:'p',effect_id:'cancel-unit',dispatch_id:d.effect.dispatch_id,operation_id:'after-reconfigure',proof_ref};await f.runtime.configure(config);await expect(async()=>old.cancelDispatchedEffect(input)).rejects.toThrow('unauthorized');await expect((f.host as unknown as typeof old).cancelDispatchedEffect(input)).resolves.toMatchObject({status:'failed'});}finally{await f.cleanup();}
});
it('refuses cancellation after begin',async()=>{
  const f=await fixture();try{await f.runtime.configure({...f.config,cancelDispatchedValidator:validator,cancel_dispatched_timeout_ms:1000});const d=await dispatched(f);await f.host.executeCommand(d.begin);const host=f.host as unknown as {cancelDispatchedEffect(input:unknown):Promise<unknown>};await expect(host.cancelDispatchedEffect({project_id:'p',effect_id:'cancel-unit',dispatch_id:d.effect.dispatch_id,operation_id:'too-late',proof_ref})).rejects.toThrow('fence_rejected');expect((await f.repository.getState('p'))?.effects['cancel-unit'].state).toBe('started');}finally{await f.cleanup();}
});
it.each(['missing','malformed','timeout'])('preserves the pending dispatch on %s cancellation proof',async kind=>{
  const f=await fixture();try{
    const config=kind==='missing'?f.config:{...f.config,cancel_dispatched_timeout_ms:5,cancelDispatchedValidator:kind==='timeout'?async()=>new Promise(()=>{}):async()=>({...await validator({proof_ref,effect:{resources:['project:p','task:t']}}),resources:['project:q']})};
    await f.runtime.configure(config);const d=await dispatched(f),before=await f.repository.getState('p');const host=f.host as unknown as {cancelDispatchedEffect(input:unknown):Promise<unknown>};
    await expect(host.cancelDispatchedEffect({project_id:'p',effect_id:'cancel-unit',dispatch_id:d.effect.dispatch_id,operation_id:'bad-proof',proof_ref})).rejects.toThrow(kind==='missing'?'protocol_incompatible':'fence_rejected');
    expect(await f.repository.getState('p')).toEqual(before);
  }finally{await f.cleanup();}
});
it('serializes cancellation winning a race against late begin',async()=>{
  const f=await fixture();let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>finish=r);
  try{await f.runtime.configure({...f.config,cancel_dispatched_timeout_ms:1000,cancelDispatchedValidator:async(request:Parameters<typeof validator>[0])=>{enter();await gate;return validator(request);}});const d=await dispatched(f),host=f.host as unknown as {cancelDispatchedEffect(input:unknown):Promise<unknown>};
    const cancellation=host.cancelDispatchedEffect({project_id:'p',effect_id:'cancel-unit',dispatch_id:d.effect.dispatch_id,operation_id:'race-cancel',proof_ref});await entered;const begin=f.host.executeCommand(d.begin);finish();await expect(cancellation).resolves.toMatchObject({status:'failed'});await expect(begin).rejects.toThrow();expect((await f.repository.getState('p'))?.effects['cancel-unit'].state).toBe('failed');
  }finally{finish?.();await f.cleanup();}
});
