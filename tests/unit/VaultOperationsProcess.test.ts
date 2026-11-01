import * as fs from 'node:fs';
import * as path from 'node:path';
import {VaultOperations} from '../../src/core/VaultOperations';
import {resolveVaultPath} from '../../src/core/vaultPath';
import {TestApp} from '../eval/headless/TestApp';
import type {Vault} from 'obsidian';

const facade=VaultOperations as unknown as {processNote(vault:Vault,path:ReturnType<typeof resolveVaultPath>,fn:(s:string)=>string):Promise<string>};
const ROOT='/Volumes/Dados/qa-temp/nexus/ciclo-producao-peca-cas';
describe('VaultOperations atomic process facade',()=>{
 let base:string;let app:TestApp;
 beforeEach(()=>{fs.mkdirSync(ROOT,{recursive:true});base=fs.mkdtempSync(path.join(ROOT,'facade-'));app=new TestApp({basePath:base});});
 afterEach(()=>fs.rmSync(base,{recursive:true,force:true}));
 it('processes an existing confined note without create/overwrite fallback',async()=>{
  await app.vault.create('AN.md','old');
  expect(await facade.processNote(app.asApp().vault,resolveVaultPath('AN.md'),s=>s==='old'?'new':'wrong')).toBe('new');
  await expect(facade.processNote(app.asApp().vault,resolveVaultPath('missing.md'),()=> 'new')).rejects.toThrow(/missing/);
  expect(fs.existsSync(path.join(base,'missing.md'))).toBe(false);
 });
 it('rejects a file moved before the atomic callback',async()=>{
  await app.vault.create('AN.md','old');const original=app.vault.process.bind(app.vault);
  app.vault.process=async(file,fn)=>{await app.vault.rename(file,'other.md');file.path='other.md';return original(file,fn);};
  await expect(facade.processNote(app.asApp().vault,resolveVaultPath('AN.md'),()=> 'new')).rejects.toThrow(/moved/);
  expect(fs.readFileSync(path.join(base,'other.md'),'utf8')).toBe('old');
 });
});
