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
