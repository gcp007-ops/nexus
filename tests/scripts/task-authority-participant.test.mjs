import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveOptions, reconcileProofs } from '../../scripts/task-authority-participant.mjs';
const receipt={operation_id:'participant-create-run',entity_id:'task',status:'committed'};
const authority={state:'passed',run_id:'run',host:'authority',fixture:{scope:'qa-run',p:'project'}};
const client={state:'passed',run_id:'run',host:'client',scope:'qa-run',project_id:'project',issuer_id:'client-issuer',receipt,after_reload:receipt,tls_trust:'system',native_client:true};
const readback={state:'passed',run_id:'run',scope:'qa-run',project_id:'project',receipt,native_count:1,priority_source_issuer:'client-issuer'};
test('reconciliation requires same-run remote participant and canonical readback',()=>{
  assert.equal(reconcileProofs(authority,client,readback,'run').state,'passed');
  for(const [a,c,r] of [[authority,{...client,host:'authority'},readback],[authority,{...client,run_id:'other'},readback],[authority,client,{...readback,native_count:2}],[authority,client,{...readback,receipt:{...receipt,entity_id:'other'}}],[authority,{...client,tls_trust:'disabled'},readback]])assert.throws(()=>reconcileProofs(a,c,r,'run'));
});
test('driver refuses missing, ambiguous and unsafe run options',()=>{
  assert.throws(()=>parseLiveOptions(['--mode','client']));
  assert.throws(()=>parseLiveOptions(['--mode','client','--run-id','../prod','--output-root','/qa']));
  assert.throws(()=>parseLiveOptions(['--mode','client','--mode','authority','--run-id','run','--output-root','/qa']));
  assert.equal(parseLiveOptions(['--mode','reconcile','--run-id','run','--output-root','/qa'])['--mode'],'reconcile');
});
