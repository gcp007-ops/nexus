jest.mock('obsidian',()=>({...jest.requireActual('obsidian'),requestUrl:jest.fn()}));
import { requestUrl } from 'obsidian';
import { TaskAuthorityHttpClient,validateClientConfiguration } from '../../src/agents/taskManager/authority/TaskAuthorityHttpClient';
import { validateServerConfiguration,TaskAuthorityHttpsServer } from '../../src/agents/taskManager/authority/TaskAuthorityHttpsServer';
import { SecretStore } from '../../src/services/secrets/SecretStore';
import { fixture } from '../helpers/taskAuthorityFixture';
const config={protocol:'task-authority-config/v1' as const,mode:'client' as const,vault_scope:'v',authority_id:'a',issuer_id:'human',service_origin:'https://authority.example',tls_trust:'system' as const,credential_secret_id:'credential',max_request_bytes:20000,request_timeout_ms:1000};
const envelope={protocol:'task-authority-command/v1',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human',operation_id:'operation',expected_revision:1,command:{type:'interactiveMutation',resources:['project:p','task:t'],mutation:{kind:'updateTask',arguments:{taskId:'t',title:'Change'}}}};
const result={vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human',operation_id:'operation',revision:2,status:'committed',kind:'updateTask',entity_id:'t'};
function secrets(){const values=new Map<string,string>([['credential','individual-token']]);return {values,store:new SecretStore({secretStorage:{getSecret:id=>values.get(id)??null,setSecret:(id,value)=>{values.set(id,value);},listSecrets:()=>[...values.keys()]}})};}
const request=jest.mocked(requestUrl);
describe('restricted authority transport',()=>{
  beforeEach(()=>request.mockReset());
  it('requires HTTPS/system TLS trust, closed provisioning and secure storage',()=>{for(const service_origin of ['http://authority.example','https://u:p@authority.example','https://authority.example/path'])expect(()=>validateClientConfiguration({...config,service_origin})).toThrow();expect(()=>validateClientConfiguration({...config,extra:1})).toThrow();expect(()=>new TaskAuthorityHttpClient(config,new SecretStore({}))).toThrow('authority_unavailable');expect(()=>validateServerConfiguration({host:'localhost',port:443})).toThrow();});
  it('sends the individual credential only as a header and validates correlation',async()=>{const s=secrets();const client=new TaskAuthorityHttpClient(config,s.store);await client.initialize();request.mockResolvedValue({status:200,headers:{},text:JSON.stringify(result),json:result,arrayBuffer:new ArrayBuffer(0)});expect(await client.executeCommand(envelope)).toEqual(result);expect(request).toHaveBeenCalledTimes(1);const args=request.mock.calls[0][0];expect(args.headers?.Authorization).toBe('Bearer individual-token');expect(args.body).not.toContain('individual-token');expect([...s.values.entries()].filter(([k])=>k.startsWith('nexus-task-authority-pending')).map(([,v])=>v)).toEqual(['']);});
  it('persists uncertainty and after restart only queries; absence never resends',async()=>{const s=secrets();const first=new TaskAuthorityHttpClient(config,s.store);await first.initialize();request.mockRejectedValue(new Error('connection lost'));await expect(first.executeCommand(envelope)).rejects.toThrow('effect_indeterminate');expect(request).toHaveBeenCalledTimes(1);const restarted=new TaskAuthorityHttpClient(config,s.store);await restarted.initialize();request.mockResolvedValue({status:200,headers:{},text:'{}',json:{state:'not_found',revision:1,result:null,error:null},arrayBuffer:new ArrayBuffer(0)});await expect(restarted.executeCommand(envelope)).rejects.toThrow('effect_indeterminate');expect(request.mock.calls[1][0].url.endsWith('/query')).toBe(true);request.mockResolvedValue({status:200,headers:{},text:'{}',json:{state:'committed',revision:2,result,error:null},arrayBuffer:new ArrayBuffer(0)});expect(await restarted.executeCommand(envelope)).toEqual(result);expect(request.mock.calls.slice(1).every(([args])=>args.url.endsWith('/query'))).toBe(true);});
  it('refuses another operation while a prior command remains uncertain',async()=>{const s=secrets();const client=new TaskAuthorityHttpClient(config,s.store);await client.initialize();request.mockRejectedValue(new Error('timeout'));await expect(client.executeCommand(envelope)).rejects.toThrow('effect_indeterminate');await expect(client.executeCommand({...envelope,operation_id:'another'})).rejects.toThrow('effect_indeterminate');expect(request).toHaveBeenCalledTimes(1);});
  it('does not open a TLS listener without secrets',async()=>{const f=await fixture();try{const server=new TaskAuthorityHttpsServer({host:'127.0.0.1',port:443,certificate_secret_id:'cert',key_secret_id:'key',max_connections:1,max_request_bytes:1000,request_timeout_ms:1000,clients:[{issuer_id:'human',credential_secret_id:'credential',project_ids:['p'],command_types:['interactiveMutation']}]},new SecretStore({}),f.runtime);await expect(server.start()).rejects.toThrow('authority_unavailable');}finally{await f.cleanup();}});
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
describe('actual TLS listener and authenticated ingress',()=>{
  it('accepts a fixture certificate explicitly trusted by the test client and refuses a revoked credential',async()=>{
    const f=await fixture();let server:TaskAuthorityHttpsServer|undefined;try{
      const certPath=path.join(f.directory,'cert.pem'),keyPath=path.join(f.directory,'key.pem');
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
      const certificate=fs.readFileSync(certPath,'utf8'),key=fs.readFileSync(keyPath,'utf8');const s=secrets();s.values.set('cert',certificate);s.values.set('key',key);
      const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const address=probe.address();if(!address||typeof address==='string')throw new Error('no local port');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
      server=new TaskAuthorityHttpsServer({host:'127.0.0.1',port,certificate_secret_id:'cert',key_secret_id:'key',max_connections:4,max_request_bytes:20000,request_timeout_ms:2000,clients:[{issuer_id:'human',credential_secret_id:'credential',project_ids:['p'],command_types:['admitProject','interactiveMutation']}]},s.store,f.runtime);await server.start();
      // Test-only requestUrl boundary uses a real TLS connection and validates
      // the fixture CA. No rejectUnauthorized:false or global trust mutation.
      request.mockImplementation(options=>new Promise((resolve,reject)=>{const url=new URL(options.url);const req=https.request({hostname:'127.0.0.1',servername:'localhost',port:url.port,path:url.pathname,method:options.method,headers:options.headers,ca:certificate},res=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode??0,headers:{},text,json:JSON.parse(text) as unknown,arrayBuffer:new ArrayBuffer(0)});});});req.on('error',reject);req.end(options.body); }));
      const client=new TaskAuthorityHttpClient({...config,service_origin:`https://localhost:${port}`},s.store);await client.initialize();const admit=await f.command('p',{type:'admitProject',baseline_hash:await f.repository.currentHash('p')});expect(await client.executeCommand(admit)).toMatchObject({status:'admitted',revision:1});
      // Revocation is read from SecretStore on every request. A different
      // device still presenting the previous token cannot mutate the project.
      s.values.set('credential','revoked-and-replaced');const isolated=secrets();const stale=new TaskAuthorityHttpClient({...config,service_origin:`https://localhost:${port}`},isolated.store);await stale.initialize();await expect(stale.query({protocol:'task-authority-query/v1',type:'getProjectCoordination',vault_scope:'v',authority_id:'a',project_id:'p',issuer_id:'human'})).rejects.toThrow('unauthorized');
      // A real TLS client with no fixture trust must reject the certificate.
      await expect(new Promise((resolve,reject)=>{const req=https.get({hostname:'127.0.0.1',servername:'localhost',port,path:'/v1/task-authority/query'},resolve);req.on('error',reject);})).rejects.toThrow();
    }finally{await server?.stop();await f.cleanup();}
  });
});
