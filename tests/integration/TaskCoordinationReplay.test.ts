import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskCoordinationRepository } from '../../src/database/repositories/TaskCoordinationRepository';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { ProjectRepository } from '../../src/database/repositories/ProjectRepository';
import { ReconcilePipeline } from '../../src/database/sync/ReconcilePipeline';
import { TaskEventApplier } from '../../src/database/sync/TaskEventApplier';
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

describe('escrita local de tarefa marca o próprio evento (causa raiz)',()=>{
it('marca como aplicado o evento de tarefa que o próprio repositório grava',async()=>{
  const f=await fixture();try{
    f.legacyWriter.appendEvent.mockImplementation(async(_p:string,d:Record<string,unknown>)=>({...d,id:'own-q',timestamp:2,deviceId:'local'}));
    const deps={sqliteCache:f.cache as never,jsonlWriter:f.legacyWriter as never,queryCache:new QueryCache({}),markWrittenTaskEvent:(id:string)=>f.cache.markEventApplied(id)};
    await new ProjectRepository(deps).update('q',{description:'x'});
    expect(await f.cache.queryOne('SELECT eventId FROM applied_events WHERE eventId=?',['own-q'])).toEqual({eventId:'own-q'});
  }finally{await f.cleanup();}
});
it('admissão logo após a escrita local não trava o shard: o evento já sai marcado',async()=>{
  const f=await fixture();try{
    let written:Record<string,unknown>|undefined;
    f.legacyWriter.appendEvent.mockImplementation(async(_p:string,d:Record<string,unknown>)=>(written={...d,id:'own-q',timestamp:2,deviceId:'local'}));
    const deps={sqliteCache:f.cache as never,jsonlWriter:f.legacyWriter as never,queryCache:new QueryCache({}),markWrittenTaskEvent:(id:string)=>f.cache.markEventApplied(id)};
    await new ProjectRepository(deps).update('q',{description:'x'});
    // Nenhum sync entre a escrita e a admissão: a janela do incidente de 2026-11-20.
    await f.admit('q');
    const cache=Object.assign(f.cache,{isEventApplied:async(id:string)=>(await f.cache.queryOne('SELECT 1 FROM applied_events WHERE eventId=?',[id]))!==null});
    const abs='Nexus/data/tasks/tasks_w';const cursors=new Map<string,unknown>();
    const store={getRootPath:()=>'Nexus/data',listFiles:async()=>['tasks/tasks_w.jsonl'],getTaskStream:()=>({category:'tasks',logicalId:'tasks_w',relativeStreamPath:'tasks/tasks_w',absoluteStreamPath:abs,shardStore:{listShards:async()=>[{fileName:'shard-000001.jsonl',fullPath:abs+'/shard-000001.jsonl',index:1,relativePath:'tasks/tasks_w/shard-000001.jsonl',size:0,modTime:0}],app:{vault:{adapter:{exists:async()=>true,read:async()=>JSON.stringify(written)}}}}})};
    const pipeline=new ReconcilePipeline({vaultEventStore:store as never,syncStateStore:{getCursor:async()=>null,upsertCursor:async(c:{shardPath:string})=>{cursors.set(c.shardPath,c);}} as never,sqliteCache:cache as never,workspaceApplier:{apply:async()=>undefined} as never,conversationApplier:{apply:async()=>undefined} as never,taskApplier:new TaskEventApplier(cache as never),deviceId:'local'});
    const result=await pipeline.reconcileAll();
    expect(result).toMatchObject({success:true,errors:[],eventsSkipped:1,eventsApplied:0});
    expect(cursors.get(abs+'/shard-000001.jsonl')).toMatchObject({lastEventId:'own-q'});
  }finally{await f.cleanup();}
});
});

describe('task-projection-heal/v1: recusa escrita alheia sobre entidade introduzida por delta (revisão C1)',()=>{
const legacy=[{type:'project_created',id:'l1',timestamp:1,deviceId:'d',data:{id:'p',workspaceId:'w',name:'p',status:'active',created:1,updated:1}},
  ...['t','u'].map((t,i)=>({type:'task_created',id:`l${i+2}`,timestamp:1,deviceId:'d',data:{id:t,projectId:'p',workspaceId:'w',title:t,status:'todo',priority:'medium',created:1,updated:1}}))];
// Saída do leitor de produção: todos os streams de tarefa, inclusive os de outro projeto.
const otherProject=[{type:'project_created',id:'q1',timestamp:1,deviceId:'d',data:{id:'q',workspaceId:'w',name:'q',status:'active',created:1,updated:1}},
  {type:'task_created',id:'q2',timestamp:1,deviceId:'d',data:{id:'x',projectId:'q',workspaceId:'w',title:'x',status:'todo',priority:'medium',created:1,updated:1}}];
const healer=(f:Awaited<ReturnType<typeof fixture>>,events:unknown[])=>new TaskCoordinationRepository({app:f.app,sqliteCache:f.cache as never,queryCache:new QueryCache({}),getDataPath:()=>'Store/data',readLegacyProjectEvents:async()=>events as never});
const withDeltaTask=async()=>{const f=await fixture();await f.admit();
  await f.runtime.executeCommand(await f.command('p',{type:'interactiveMutation',resources:['project:p'],mutation:{kind:'createTask',arguments:{projectId:'p',title:'n',priority:'medium'}}}));
  const row=await f.cache.queryOne<{id:string}>("SELECT id FROM tasks WHERE title='n'");return {f,id:row!.id};};
for(const [label,extra] of [['legado só do projeto',[]],['legado de todos os streams',otherProject]] as const){
it(`recusa e preserva task_updated alheio sobre tarefa criada por delta (${label})`,async()=>{const {f,id}=await withDeltaTask();try{
  await f.cache.run("UPDATE tasks SET title='Alien',updated=5 WHERE id=?",[id]);
  const events=[...legacy,...extra,{type:'task_updated',id:'l9',timestamp:5,deviceId:'upstream',taskId:id,data:{title:'Alien',updated:5}}];
  await expect(healer(f,events).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',[id])).toEqual({title:'Alien'});
  expect(await f.cache.queryOne("SELECT eventId FROM applied_events WHERE eventId='l9'")).toBeNull();
}finally{await f.cleanup();}});
it(`recusa e preserva task_deleted alheio sobre tarefa criada por delta (${label})`,async()=>{const {f,id}=await withDeltaTask();try{
  await f.cache.run('DELETE FROM tasks WHERE id=?',[id]);
  const events=[...legacy,...extra,{type:'task_deleted',id:'l8',timestamp:5,deviceId:'upstream',taskId:id,data:{}}];
  await expect(healer(f,events).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.queryOne('SELECT id FROM tasks WHERE id=?',[id])).toBeNull();
  expect(await f.cache.queryOne("SELECT eventId FROM applied_events WHERE eventId='l8'")).toBeNull();
}finally{await f.cleanup();}});
}
it('recusa e preserva remoção alheia de dependência criada por delta entre tarefas da base',async()=>{const f=await fixture();try{await f.admit();
  await f.runtime.executeCommand(await f.command('p',{type:'interactiveMutation',resources:['project:p','task:t','task:u'],mutation:{kind:'updateTask',arguments:{taskId:'t',addDependencies:['u']}}}));
  await f.cache.run("DELETE FROM task_dependencies WHERE taskId='t' AND dependsOnTaskId='u'");
  const events=[...legacy,...otherProject,{type:'task_dependency_removed',id:'l7',timestamp:5,deviceId:'upstream',taskId:'t',dependsOnTaskId:'u',data:{dependsOnTaskId:'u'}}];
  await expect(healer(f,events).replay()).rejects.toThrow('authority operational base diverged');
  expect(await f.cache.query('SELECT * FROM task_dependencies')).toEqual([]);
  expect(await f.cache.queryOne("SELECT eventId FROM applied_events WHERE eventId='l7'")).toBeNull();
}finally{await f.cleanup();}});
it('não refaz a reconstrução enquanto a recusa persiste (mesma revisão, hash e legado)',async()=>{const {f,id}=await withDeltaTask();try{
  await f.cache.run("UPDATE tasks SET title='Alien',updated=5 WHERE id=?",[id]);
  const events=[...legacy,{type:'task_updated',id:'l9',timestamp:5,deviceId:'upstream',taskId:id,data:{title:'Alien',updated:5}}];
  const repo=healer(f,events);const transaction=jest.spyOn(f.cache,'transaction');
  await expect(repo.replay()).rejects.toThrow('authority operational base diverged');const first=transaction.mock.calls.length;
  await expect(repo.replay()).rejects.toThrow('authority operational base diverged');
  expect(first).toBeGreaterThan(0);expect(transaction.mock.calls.length).toBe(first);
}finally{await f.cleanup();}});
});
