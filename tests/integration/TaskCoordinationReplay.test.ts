import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskCoordinationRepository } from '../../src/database/repositories/TaskCoordinationRepository';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
// If event append is skipped, clone leaks a partial write, or replay repeats a
// delta after a cache fault, these checks run against actual disk and SQL.
describe('canonical coordination through disk and SQL',()=>{
  it('commits compound native task mutation, deduplicates before CAS, and rebuilds from the journal',async()=>{
    const f=await fixture();try{
      await f.admit();
      const envelope=await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t','task:u'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Changed',addDependencies:['u'],addNoteLinks:[{notePath:'Manual.md'}]}}});
      const result=await f.runtime.executeCommand(envelope);expect(result).toMatchObject({status:'committed',revision:2,entity_id:'t'});
      expect(await f.runtime.executeCommand(envelope)).toEqual(result);
      await expect(f.runtime.executeCommand({...envelope,command:{...envelope.command,mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Different'}}}})).rejects.toThrow('operation_signature_conflict');
      expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'Changed'});
      // Simulate a fresh cache reconstructed from the legacy baseline before
      // authority history. Its operational baseline is the same seeded data.
      const clone=new (f.cache.constructor as new()=>typeof f.cache)();await clone.seed();
      const repo=new TaskCoordinationRepository({app:f.app,sqliteCache:clone as unknown as SQLiteCacheManager,queryCache:new QueryCache({}),getDataPath:()=> 'Store/data'});
      await repo.replay();await repo.replay();
      expect(await clone.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'Changed'});
      expect(await clone.query('SELECT * FROM task_dependencies')).toHaveLength(1);expect(await clone.query('SELECT * FROM task_note_links')).toHaveLength(1);
      expect(await repo.getReceipt('p','human',String(envelope.operation_id))).toMatchObject({result});clone.db.close();
    }finally{await f.cleanup();}
  });
  it('does not leak a first staged write when a later dependency is invalid',async()=>{
    const f=await fixture();try{await f.admit();await expect(f.runtime.executeCommand(await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t','task:x'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Must rollback',addDependencies:['x']}}}))).rejects.toThrow('invalid_command');expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'t'});expect(await f.repository.getState('p')).toMatchObject({revision:1});}finally{await f.cleanup();}
  });
  it('recovers event durable/cache failed without reexecuting the mutation',async()=>{
    const f=await fixture();try{await f.admit();const envelope=await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Durable'}}});f.cache.failNextMarker=true;
      await expect(f.runtime.executeCommand(envelope)).rejects.toThrow('authority_unavailable');expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'t'});
      await f.repository.replay();expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'Durable'});await f.runtime.configure(f.config);expect(await f.runtime.executeCommand(envelope)).toMatchObject({status:'committed',entity_id:'t',revision:2});
    }finally{await f.cleanup();}
  });
});

describe('task-projection-heal/v1: cura que recusa quando falha',()=>{
const legacy=[{type:'project_created',id:'l1',timestamp:1,deviceId:'d',data:{id:'p',workspaceId:'w',name:'p',status:'active',created:1,updated:1}},
  ...['t','u'].map((t,i)=>({type:'task_created',id:`l${i+2}`,timestamp:1,deviceId:'d',data:{id:t,projectId:'p',workspaceId:'w',title:t,status:'todo',priority:'medium',created:1,updated:1}}))];
const healer=(f:Awaited<ReturnType<typeof fixture>>,events:unknown[])=>new TaskCoordinationRepository({app:f.app,sqliteCache:f.cache as never,queryCache:new QueryCache({}),getDataPath:()=>'Store/data',readLegacyProjectEvents:async()=>events as never});
const diverge=async(f:Awaited<ReturnType<typeof fixture>>)=>{await f.admit();
  await f.runtime.executeCommand(await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Changed'}}}));
  await f.cache.run("UPDATE tasks SET title='t',updated=1 WHERE id='t'");}; // o que o replay sem guarda fez
it('cura divergência explicada por delta ausente',async()=>{const f=await fixture();try{await diverge(f);
  await expect(f.repository.replay()).rejects.toThrow('authority operational base diverged');
  const repo=healer(f,legacy);await repo.replay();
  expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'Changed'});
  expect(await repo.currentHash('p')).toBe((await repo.getState('p'))!.operationalHash);
  expect(await f.cache.queryOne('SELECT eventId FROM applied_events WHERE eventId=?',['l1'])).toEqual({eventId:'l1'});
}finally{await f.cleanup();}});
it('recusa e preserva escrita legada alheia posterior à admissão',async()=>{const f=await fixture();try{await diverge(f);
  await f.cache.run("UPDATE tasks SET title='Alien',updated=5 WHERE id='u'");
  const alien=[...legacy,{type:'task_updated',id:'l9',timestamp:5,deviceId:'upstream',taskId:'u',data:{title:'Alien',updated:5}}];
  const before=await f.repository.operationalSource('p');
  await expect(healer(f,alien).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.repository.operationalSource('p')).toEqual(before);
  expect(await f.cache.queryOne('SELECT eventId FROM applied_events WHERE eventId=?',['l9'])).toBeNull();
}finally{await f.cleanup();}});
it('recusa quando a cura tocaria outro projeto',async()=>{const f=await fixture();try{
  await f.cache.run("INSERT INTO task_dependencies VALUES ('x','t',1)");await diverge(f);
  await expect(healer(f,legacy).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.query('SELECT * FROM task_dependencies')).toHaveLength(1);
}finally{await f.cleanup();}});
it('recusa e preserva dependência de outro projeto criada depois da admissão',async()=>{const f=await fixture();try{await diverge(f);
  await f.cache.run("INSERT INTO task_dependencies VALUES ('x','t',1)");
  await expect(healer(f,legacy).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.query('SELECT taskId,dependsOnTaskId FROM task_dependencies')).toEqual([{taskId:'x',dependsOnTaskId:'t'}]);
}finally{await f.cleanup();}});
it('recusa e preserva filho em outro projeto criado depois da admissão',async()=>{const f=await fixture();try{await diverge(f);
  await f.cache.run("INSERT INTO tasks(id,projectId,workspaceId,parentTaskId,title,status,priority,created,updated) VALUES ('y','q','w','t','y','todo','medium',1,1)");
  await expect(healer(f,legacy).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.queryOne('SELECT parentTaskId FROM tasks WHERE id=?',['y'])).toEqual({parentTaskId:'t'});
}finally{await f.cleanup();}});
});
