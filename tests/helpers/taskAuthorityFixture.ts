/** Native SQLite + disk fixture. No mock decides command results, CAS, replay,
 * lease collisions or business rules; only the Obsidian adapter is emulated. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { webcrypto } from 'node:crypto';
import type { App } from 'obsidian';
import { Platform } from 'obsidian';
import { TaskCoordinationRepository } from '../../src/database/repositories/TaskCoordinationRepository';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLiteTransactionCoordinator } from '../../src/database/storage/SQLiteTransactionCoordinator';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { TaskAuthorityRuntime, type TaskAuthorityConfiguration, type TaskAuthorityHostPort } from '../../src/agents/taskManager/authority/TaskAuthorityRuntime';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { ProjectRepository } from '../../src/database/repositories/ProjectRepository';
import { TaskService } from '../../src/agents/taskManager/services/TaskService';
import { DAGService } from '../../src/agents/taskManager/services/DAGService';
// The installed @types/node predates node:sqlite, available in the test runtime.
interface Statement { all(...p: unknown[]): Record<string,unknown>[]; get(...p: unknown[]): Record<string,unknown>|undefined; run(...p: unknown[]): {changes:number;lastInsertRowid:number|bigint} }
interface NativeDB { exec(sql:string):void; prepare(sql:string):Statement; close():void }
const NativeDatabase = (require('node:sqlite') as {DatabaseSync:new(path:string,options?:unknown)=>NativeDB}).DatabaseSync;
const schema = `CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT);
CREATE TABLE projects(id TEXT PRIMARY KEY,workspaceId TEXT,name TEXT,description TEXT,status TEXT,created INTEGER,updated INTEGER,metadataJson TEXT);
CREATE TABLE tasks(id TEXT PRIMARY KEY,projectId TEXT,workspaceId TEXT,parentTaskId TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,created INTEGER,updated INTEGER,completedAt INTEGER,dueDate INTEGER,assignee TEXT,tagsJson TEXT,metadataJson TEXT);
CREATE TABLE task_dependencies(taskId TEXT,dependsOnTaskId TEXT,created INTEGER,PRIMARY KEY(taskId,dependsOnTaskId));
CREATE TABLE task_note_links(taskId TEXT,notePath TEXT,linkType TEXT,created INTEGER,PRIMARY KEY(taskId,notePath));
CREATE TABLE applied_events(eventId TEXT PRIMARY KEY);
CREATE TABLE task_coordination_state(vaultScope TEXT,authorityId TEXT,projectId TEXT,revision INTEGER,epoch INTEGER,baselineHash TEXT,stateJson TEXT,PRIMARY KEY(vaultScope,authorityId,projectId));
CREATE TABLE task_coordination_receipts(vaultScope TEXT,authorityId TEXT,projectId TEXT,issuerId TEXT,operationId TEXT,signature TEXT,revision INTEGER,resultJson TEXT,PRIMARY KEY(vaultScope,authorityId,projectId,issuerId,operationId));`;
export class RealCache {
  readonly db = new NativeDatabase(':memory:', {enableForeignKeyConstraints:false});
  private serial = new SQLiteTransactionCoordinator();
  failNextMarker = false;
  constructor() { this.db.exec(schema); }
  query<T>(sql:string,p:unknown[]=[]):Promise<T[]> { return Promise.resolve(this.db.prepare(sql).all(...p) as T[]); }
  queryOne<T>(sql:string,p:unknown[]=[]):Promise<T|null> { return Promise.resolve((this.db.prepare(sql).get(...p) as T|undefined)??null); }
  run(sql:string,p:unknown[]=[]):Promise<unknown> { return Promise.resolve(this.db.prepare(sql).run(...p)); }
  transaction<T>(fn:()=>Promise<T>):Promise<T> { return this.serial.run(async()=>this.db.exec('BEGIN'),async()=>this.db.exec('COMMIT'),async()=>this.db.exec('ROLLBACK'),fn); }
  async markEventApplied(id:string):Promise<void> { if(this.failNextMarker){this.failNextMarker=false;throw new Error('injected marker failure');}await this.run('INSERT OR IGNORE INTO applied_events VALUES (?)',[id]); }
  createPlanningClone(): {cache:SQLiteCacheManager;dispose():void} {
    const clone = new RealCache();
    for(const table of ['workspaces','projects','tasks','task_dependencies','task_note_links','applied_events','task_coordination_state','task_coordination_receipts']) {
      for(const row of this.db.prepare(`SELECT * FROM ${table}`).all()) { const keys=Object.keys(row);clone.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k])); }
    }
    return {cache:clone as unknown as SQLiteCacheManager,dispose:()=>clone.db.close()};
  }
  async seed():Promise<void> { await this.run("INSERT INTO workspaces VALUES ('w','Workspace')"); for(const p of ['p','q'])await this.run("INSERT INTO projects VALUES (?,'w',?,NULL,'active',1,1,NULL)",[p,p]);for(const t of ['t','u']) await this.run("INSERT INTO tasks(id,projectId,workspaceId,title,status,priority,created,updated) VALUES (?,'p','w',?,'todo','medium',1,1)",[t,t]);await this.run("INSERT INTO tasks(id,projectId,workspaceId,title,status,priority,created,updated) VALUES ('x','q','w','x','todo','medium',1,1)"); }
}
export async function fixture() {
  Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
  Object.defineProperty(globalThis,'window',{value:{require,setTimeout,clearTimeout},configurable:true});
  Object.assign(Platform,{isDesktop:true,isMobile:false});
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'nexus-authority-'));fs.mkdirSync(path.join(directory,'Store/data'),{recursive:true});
  const adapter={getBasePath:()=>directory,exists:async(p:string)=>fs.existsSync(path.join(directory,p)),read:async(p:string)=>fs.promises.readFile(path.join(directory,p),'utf8'),list:async(p:string)=>{const entries=await fs.promises.readdir(path.join(directory,p),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>`${p}/${e.name}`),folders:entries.filter(e=>e.isDirectory()).map(e=>`${p}/${e.name}`)};}};
  const app={vault:{adapter}} as unknown as App;const cache=new RealCache();await cache.seed();const queryCache=new QueryCache({});
  const repository=new TaskCoordinationRepository({app,sqliteCache:cache as unknown as SQLiteCacheManager,queryCache,getDataPath:()=> 'Store/data'});
  const storage={taskCoordination:repository,waitForQueryReady:async()=>true} as unknown as IStorageAdapter;
  let host:TaskAuthorityHostPort;
  const config:TaskAuthorityConfiguration={protocol:'task-authority-config/v1',mode:'authority',bindHost:port=>{host=port;},vault_scope:'v',authority_id:'a',issuer_id:'human',host_id:'host',max_lease_ms:10000,eligible_project_ids:['p','q'],capabilityValidator:async e=>({resources:(e.command as {resources?:string[]}).resources??['project:p','task:t'],max_lease_ms:10000}),artifactValidator:async()=>true};
  const runtime=new TaskAuthorityRuntime(storage);await runtime.configure(config);
  let sequence=0;
  const command=async(project:string,body:Record<string,unknown>,overrides:Record<string,unknown>={})=>({protocol:'task-authority-command/v1',vault_scope:'v',authority_id:'a',project_id:project,issuer_id:['beginEffect','recordEffect'].includes(String(body.type))?'host':'human',operation_id:`operation-${++sequence}`,expected_revision:(await repository.getState(project))?.revision??0,command:body,...overrides});
  const admit=async(project='p')=>runtime.executeCommand(await command(project,{type:'admitProject',baseline_hash:await repository.currentHash(project)}));
  const legacyWriter={appendEvent:jest.fn()};const deps={sqliteCache:cache as unknown as SQLiteCacheManager,jsonlWriter:legacyWriter as never,queryCache,taskMutationGuard:(id:string)=>repository.assertLegacyMutationAllowed(id)};
  const service=new TaskService(new ProjectRepository(deps),new TaskRepository(deps),new DAGService(),undefined,undefined,undefined,runtime);
  return {get host(){return host;},directory,cache,app,storage,repository,runtime,config,command,admit,service,legacyWriter,cleanup:async()=>{await runtime.close();cache.db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
