import { Journal } from '../helpers/ContentCasJournal';
/**
 * If CAS checks a stale pre-read instead of the Vault.process callback, a
 * concurrent editor is overwritten. These tests exercise real filesystem
 * bytes with the headless Vault. They do not certify Obsidian's implementation
 * of process or production receipt durability; those need the isolated app gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TestApp } from '../eval/headless/TestApp';
import type { ToolContext } from '../../src/types/mcp/AgentTypes';
import type { ToolOperationPersistenceProvider } from '../../src/agents/toolManager/services/ToolOperationService';

const ROOT = '/Volumes/Dados/qa-temp/nexus/ciclo-producao-peca-cas';
const context: ToolContext = { workspaceId: 'test-ws', sessionId: 'cas-test', memory: 'Testing CAS', goal: 'Preserve concurrent changes' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface Params {path: string; mutationId: string; expectedHash: string; expectedContent: string; content: string; context: ToolContext}
interface Receipt {operation_id: string; path: string; old_hash: string; new_hash: string; outcome: string}
interface CasAPI {apply(p: Params): Promise<Receipt>; status(id: string, ctx: ToolContext): Promise<{status: string; receipt: Receipt | null}>}


function service(app: TestApp, provider: ToolOperationPersistenceProvider): CasAPI {
  // Runtime require lets the initial RED state report the missing behavior.
  const module = require('../../src/agents/contentManager/services/ContentCasService') as {
    ContentCasService: new (app: ReturnType<TestApp['asApp']>, provider: ToolOperationPersistenceProvider) => CasAPI;
  };
  return new module.ContentCasService(app.asApp(), provider);
}

describe('content CAS orchestration', () => {
  let base: string;let app: TestApp;let journal: Journal;let cas: CasAPI;
  const request = (content = 'new'): Params => ({path:'AN.md', mutationId:'mutation-1', expectedHash:hash('old'),expectedContent:'old',content,context});
  beforeEach(async () => {
    fs.mkdirSync(ROOT,{recursive:true});base = fs.mkdtempSync(path.join(ROOT,'case-'));
    app = new TestApp({basePath:base});await app.vault.create('AN.md','old');journal = new Journal();
    cas = service(app,async()=>({isReady:()=>true,operations:journal}));
  });
  afterEach(()=>fs.rmSync(base,{recursive:true,force:true}));

  it('persists a claim before changing bytes and replays without another write',async()=>{
    const original=app.vault.process.bind(app.vault);let calls=0;
    app.vault.process=async(file,fn)=>{expect(journal.rows.size).toBe(1);calls++;return original(file,fn);};
    const receipt=await cas.apply(request());
    expect(receipt).toEqual(expect.objectContaining({old_hash:hash('old'),new_hash:hash('new'),path:'AN.md',operation_id:'mutation-1'}));
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('new');
    expect(await cas.apply(request())).toEqual(receipt);expect(calls).toBe(1);
  });
  it('compares the exact content inside process, preserving a concurrent editor',async()=>{
    const original=app.vault.process.bind(app.vault);
    app.vault.process=async(file,fn)=>{fs.writeFileSync(path.join(base,'AN.md'),'external');return original(file,fn);};
    await expect(cas.apply(request())).rejects.toThrow(/cas_conflict/);
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('external');
  });
  it('does not normalize CRLF into an equal precondition',async()=>{
    fs.writeFileSync(path.join(base,'AN.md'),'old\r\n');
    await expect(cas.apply({...request(),expectedContent:'old\n',expectedHash:hash('old\n')})).rejects.toThrow(/cas_conflict/);
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('old\r\n');
  });
  it('refuses a forged hash before journaling or writing',async()=>{
    await expect(cas.apply({...request(),expectedHash:'a'.repeat(64)})).rejects.toThrow(/expected_hash/);
    expect(journal.rows.size).toBe(0);
  });
  it('recovers a crash after effect without another note write',async()=>{
    journal.crashOnComplete=true;
    await expect(cas.apply(request())).rejects.toThrow('crash_after_effect');
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('new');
    const next=service(app,async()=>({isReady:()=>true,operations:journal}));
    expect((await next.status('mutation-1',context)).receipt).toEqual(expect.objectContaining({new_hash:hash('new'),outcome:'recovered'}));
    journal.crashOnComplete=false;
    const original=app.vault.process.bind(app.vault);let calls=0;
    app.vault.process=async(file,fn)=>{calls++;return original(file,fn);};
    expect((await next.apply(request())).outcome).toBe('recovered');expect(calls).toBe(0);
  });
  it('never retries a changed post-effect document',async()=>{
    journal.crashOnComplete=true;await expect(cas.apply(request())).rejects.toThrow();
    fs.writeFileSync(path.join(base,'AN.md'),'external-after');journal.crashOnComplete=false;
    await expect(cas.apply(request())).rejects.toThrow(/cas_conflict/);
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('external-after');
  });
  it('rejects reusing a mutation id with a different payload',async()=>{
    await cas.apply(request());await expect(cas.apply(request('different'))).rejects.toThrow(/mutation_conflict/);
  });
  it('fails closed without query-ready receipt storage',async()=>{
    cas=service(app,async()=>({isReady:()=>false,operations:journal}));
    await expect(cas.apply(request())).rejects.toThrow(/storage_not_ready/);
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('old');
  });
  it('rejects traversal, no-op and malformed ids before effects',async()=>{
    for(const patch of [{path:'../private.md'},{content:'old'},{mutationId:'../bad'}]){
      await expect(cas.apply({...request(),...patch})).rejects.toThrow();
    }
    expect(journal.rows.size).toBe(0);
  });
  it('two service owners cannot overwrite one another from the same expected bytes',async()=>{
    const second=service(app,async()=>({isReady:()=>true,operations:journal}));
    const result=await Promise.allSettled([cas.apply(request('one')),second.apply({...request('two'),mutationId:'mutation-2'})]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(['one','two']).toContain(fs.readFileSync(path.join(base,'AN.md'),'utf8'));
  });
  it('does not return another workspace receipt',async()=>{
    await cas.apply(request());expect(await cas.status('mutation-1',{...context,workspaceId:'other'})).toEqual({status:'missing',receipt:null});
  });
  it('preserves the recovered outcome on subsequent terminal replay',async()=>{
    journal.crashOnComplete=true;await expect(cas.apply(request())).rejects.toThrow();
    journal.crashOnComplete=false;
    expect((await cas.apply(request())).outcome).toBe('recovered');
    expect((await cas.apply(request())).outcome).toBe('recovered');
  });
  it('recovers when process rejects after committing its callback output',async()=>{
    const original=app.vault.process.bind(app.vault);
    app.vault.process=async(file,fn)=>{await original(file,fn);throw new Error('lost_process_reply');};
    const result=await cas.apply(request());
    expect(result.outcome).toBe('recovered');
    expect((await cas.status('mutation-1',context)).receipt?.new_hash).toBe(hash('new'));
  });

  it('never repeats an uncertain effect after an external restoration of the old bytes',async()=>{
    journal.crashOnComplete=true;await expect(cas.apply(request())).rejects.toThrow('crash_after_effect');
    fs.writeFileSync(path.join(base,'AN.md'),'old');journal.crashOnComplete=false;
    const next=service(app,async()=>({isReady:()=>true,operations:journal}));
    await expect(next.apply(request())).rejects.toThrow(/effect_indeterminate/);
    expect(fs.readFileSync(path.join(base,'AN.md'),'utf8')).toBe('old');
    expect((await next.status('mutation-1',context)).status).toBe('indeterminate');
  });

  it('verifies physical bytes when Vault.read strips a BOM after writing',async()=>{
    const old='\uFEFFold';const next='\uFEFFnew';fs.writeFileSync(path.join(base,'AN.md'),old);
    const originalRead=app.vault.read.bind(app.vault);const originalProcess=app.vault.process.bind(app.vault);let after=false;
    app.vault.read=async file=>{const text=await originalRead(file);return after?text.replace(/^\uFEFF/,''):text;};
    app.vault.process=async(file,fn)=>{const result=await originalProcess(file,fn);after=true;return result;};
    const result=await cas.apply({...request(),expectedContent:old,expectedHash:hash(old),content:next});
    expect(result.new_hash).toBe(hash(next));
    expect((await cas.status('mutation-1',context)).receipt?.new_hash).toBe(hash(next));
  });

});
