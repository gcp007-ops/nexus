import { fixture } from '../helpers/taskAuthorityFixture';
import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { ProjectRepository } from '../../src/database/repositories/ProjectRepository';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { TaskEventApplier } from '../../src/database/sync/TaskEventApplier';
describe('admitted surfaces',()=>{
  it('routes the real TaskService to the durable event and blocks legacy repository bypass',async()=>{
    const f=await fixture();try{await f.admit();await f.service.updateTask('t',{title:'Shared facade'});expect(await f.cache.queryOne('SELECT title FROM tasks WHERE id=?',['t'])).toEqual({title:'Shared facade'});expect(f.legacyWriter.appendEvent).not.toHaveBeenCalled();
      const deps={sqliteCache:f.cache as unknown as SQLiteCacheManager,jsonlWriter:f.legacyWriter as never,queryCache:new QueryCache({}),taskMutationGuard:(id:string)=>f.repository.assertLegacyMutationAllowed(id)};const tasks=new TaskRepository(deps);const projects=new ProjectRepository(deps);
      await expect(tasks.update('t',{title:'Bypass'})).rejects.toThrow('protocol_incompatible');await expect(tasks.update('x',{projectId:'p'})).rejects.toThrow('protocol_incompatible');await expect(tasks.create({projectId:'p',workspaceId:'w',title:'Bypass'})).rejects.toThrow('protocol_incompatible');await expect(projects.delete('p')).rejects.toThrow('protocol_incompatible');
      await expect(new TaskEventApplier(f.cache as unknown as SQLiteCacheManager).apply({id:'rogue',timestamp:9,deviceId:'old',type:'task_updated',taskId:'t',data:{title:'Rogue'}})).rejects.toThrow('uncoordinated');expect(f.legacyWriter.appendEvent).not.toHaveBeenCalled();
    }finally{await f.cleanup();}
  });
  it('rejects both transfer directions before any write',async()=>{const f=await fixture();try{await f.admit();await expect(f.service.moveTask('t',{projectId:'q'})).rejects.toThrow('protocol_incompatible');await expect(f.service.moveTask('x',{projectId:'p'})).rejects.toThrow('protocol_incompatible');expect(f.legacyWriter.appendEvent).not.toHaveBeenCalled();}finally{await f.cleanup();}});
});
