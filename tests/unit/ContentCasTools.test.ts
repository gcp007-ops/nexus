/** Proves real CLI values/context reach the CAS service, not a result fixture. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {TestApp} from '../eval/headless/TestApp';
import {Journal} from '../helpers/ContentCasJournal';
import {ContentManagerAgent} from '../../src/agents/contentManager/contentManager';
import {ToolManagerAgent} from '../../src/agents/toolManager/toolManager';
import type {ToolOperationPersistenceProvider} from '../../src/agents/toolManager/services/ToolOperationService';

const ROOT='/Volumes/Dados/qa-temp/nexus/ciclo-producao-peca-cas';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const ctx={workspaceId:'default',sessionId:'cas-cli-test',memory:'Testing CAS CLI',goal:'Preserve exact bytes'};

describe('content CAS CLI boundary',()=>{
 let base:string;let app:TestApp;let manager:ToolManagerAgent;let journal:Journal;
 beforeEach(()=>{
  fs.mkdirSync(ROOT,{recursive:true});base=fs.mkdtempSync(path.join(ROOT,'cli-'));app=new TestApp({basePath:base});journal=new Journal();
  const provider:ToolOperationPersistenceProvider=async()=>({isReady:()=>true,operations:journal});
  const content=Reflect.construct(ContentManagerAgent,[app.asApp(),undefined,undefined,undefined,provider]) as ContentManagerAgent;
  manager=new ToolManagerAgent(app.asApp(),new Map([['contentManager',content]]),{workspaces:[],customAgents:[],vaultRoot:[]});
 });
 afterEach(()=>fs.rmSync(base,{recursive:true,force:true}));
 it('preserves BOM, CRLF, quotes, backslashes and flag-like text via values',async()=>{
  const old='\uFEFF# AN\r\n"c:\\autos" --ref texto\r\n';const next=old+'Decisão do sócio.\r\n';
  await app.vault.create('AN.md',old);
  const use=manager.getTool('useTools');expect(use).toBeDefined();
  const result=await use!.execute({...ctx,tool:'content cas --path AN.md --mutation-id cli-1 --expected-hash '+hash(old)+' --expected-content @old --content @next',values:{old,next}});
  expect(result).toEqual(expect.objectContaining({success:true}));
  expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe(next);
  expect([...journal.rows.values()][0]).toEqual(expect.objectContaining({workspaceId:'default',sessionId:'cas-cli-test'}));
  const status=await use!.execute({...ctx,tool:'content cas-status cli-1'});
  expect(status).toEqual(expect.objectContaining({success:true}));
  expect(JSON.stringify(status)).toContain(hash(next));
 });
 it('rejects missing runtime arguments without changing the note',async()=>{
  await app.vault.create('AN.md','old');
  const use=manager.getTool('useTools');expect(use).toBeDefined();
  await expect(use!.execute({...ctx,tool:'content cas --path AN.md --mutation-id missing'})).rejects.toThrow(/Missing|required/);
  expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('old');expect(journal.rows.size).toBe(0);
 });
});
