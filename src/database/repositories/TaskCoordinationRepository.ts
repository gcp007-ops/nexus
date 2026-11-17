import type { TaskPriorityEvidence } from '../../agents/taskManager/authority/TaskAuthorityContracts';
import type { App } from 'obsidian';
import { SecretStore } from '../../services/secrets/SecretStore';
import { isDesktop } from '../../utils/platform';
import { desktopRequire } from '../../utils/desktopRequire';
import { authorityHash } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
import { TaskAuthorityDurableJournal } from '../storage/TaskAuthorityDurableJournal';
import type { SQLiteCacheManager } from '../storage/SQLiteCacheManager';
import type { QueryCache } from '../optimizations/QueryCache';
import { TaskEventApplier } from '../sync/TaskEventApplier';
import { readAuthorityJournals } from '../storage/TaskAuthorityJournalReader';
import { prepareMutation, type InteractiveMutation, projectHash, canonicalJson, operationalSnapshot } from '../../agents/taskManager/authority/TaskAuthorityPlanning';
import type { AuthorityJournalEvent, AuthorityProjectState, AuthorityReceipt, CoordinationCommittedEvent, ITaskCoordinationRepository } from './interfaces/ITaskCoordinationRepository';
const key = (issuer: string, operation: string): string => JSON.stringify([issuer, operation]);
export interface CoordinationRepositoryOptions { app: App; sqliteCache: SQLiteCacheManager; queryCache: QueryCache; getDataPath(): string | null }
/** Owns canonical history validation and its rebuildable SQL projection. It
 * never invokes an executor, even for an event left open at a crash. */
export class TaskCoordinationRepository implements ITaskCoordinationRepository {
  private replayPromise: Promise<void> | null = null;
  constructor(private readonly options: CoordinationRepositoryOptions) {}
  secretStore(): SecretStore { return new SecretStore(this.options.app); }
  async allStates(): Promise<AuthorityProjectState[]> { const rows = await this.options.sqliteCache.query<{stateJson: string}>('SELECT stateJson FROM task_coordination_state'); return rows.map(row => JSON.parse(row.stateJson) as AuthorityProjectState); }
  async scopedStates(vaultScope:string,authorityId:string):Promise<Array<{project_id:string;state:AuthorityProjectState}>> {
    const rows=await this.options.sqliteCache.query<{projectId:string;stateJson:string}>('SELECT projectId,stateJson FROM task_coordination_state WHERE vaultScope=? AND authorityId=? ORDER BY projectId',[vaultScope,authorityId]);
    return rows.map(row=>({project_id:row.projectId,state:JSON.parse(row.stateJson) as AuthorityProjectState}));
  }
  async requireActiveProject(projectId:string):Promise<void>{const row=await this.options.sqliteCache.queryOne<{status:string}>('SELECT status FROM projects WHERE id=?',[projectId]);if(row?.status!=='active')throw new Error('fence_rejected');}
  async requireTask(projectId: string, taskId: string): Promise<{status: string}> { const row = await this.options.sqliteCache.queryOne<{projectId: string; status: string}>('SELECT projectId,status FROM tasks WHERE id=?', [taskId]); if (!row || row.projectId !== projectId) throw new Error('invalid_command'); return row; }
  async currentHash(projectId: string): Promise<string> { return projectHash(this.options.sqliteCache, projectId); }
  async operationalSource(projectId:string):Promise<unknown[]> { return operationalSnapshot(this.options.sqliteCache,projectId); }
  async prepare(projectId: string, mutation: InteractiveMutation, priorityProvenance?: {value:string;decision_ref:string;source_operation_id:string}) { return prepareMutation(this.options.sqliteCache, projectId, mutation, priorityProvenance); }
  async validateEligibility(projectId:string, taskId:string, vaultScope:string, authorityId:string):Promise<void> {
    const cache=this.options.sqliteCache;
    const project=await cache.queryOne<{status:string}>('SELECT status FROM projects WHERE id=?',[projectId]);
    const task=await cache.queryOne<{projectId:string;status:string;priority:string;created:number;metadataJson:string|null}>('SELECT projectId,status,priority,created,metadataJson FROM tasks WHERE id=?',[taskId]);
    if(project?.status!=='active'||!task||task.projectId!==projectId||!['todo','in_progress'].includes(task.status)||!Number.isFinite(task.created)||task.created<0)throw new Error('fence_rejected');
    const dependencies=await cache.query<{status:string|null;projectId:string|null}>('SELECT t.status,t.projectId FROM task_dependencies d LEFT JOIN tasks t ON t.id=d.dependsOnTaskId WHERE d.taskId=?',[taskId]);
    if(dependencies.some(dep=>dep.projectId!==projectId||!['done','cancelled'].includes(dep.status??'')))throw new Error('fence_rejected');
    if(!await this.readPriorityEvidence(projectId,taskId,vaultScope,authorityId))throw new Error('fence_rejected');
  }
  async readPriorityEvidence(projectId:string,taskId:string,vaultScope:string,authorityId:string):Promise<TaskPriorityEvidence|null>{
    const task=await this.options.sqliteCache.queryOne<{projectId:string;priority:string;metadataJson:string|null}>('SELECT projectId,priority,metadataJson FROM tasks WHERE id=?',[taskId]);
    if(!task||task.projectId!==projectId||!['critical','high','medium','low'].includes(task.priority))return null;
    let provenance:{value?:unknown;decision_ref?:unknown;source_operation_id?:unknown}|undefined;
    try{const metadata=JSON.parse(task.metadataJson??'{}') as Record<string,unknown>;provenance=metadata.dream_priority_v1 as typeof provenance;}catch{return null;}
    if(!provenance||Object.keys(provenance).sort().join(',')!=='decision_ref,source_operation_id,value'||provenance.value!==task.priority||typeof provenance.decision_ref!=='string'||typeof provenance.source_operation_id!=='string')return null;
    const prefix='task-authority-decision/v1/';if(!provenance.decision_ref.startsWith(prefix))return null;
    let parts:string[];try{parts=provenance.decision_ref.slice(prefix.length).split('/').map(decodeURIComponent);}catch{return null;}
    if(parts.length!==5||parts[0]!==vaultScope||parts[1]!==authorityId||parts[2]!==projectId||parts[4]!==provenance.source_operation_id)return null;
    const receipt=await this.getReceipt(projectId,parts[3],parts[4]);
    if(receipt?.error||!receipt?.priorityAssignment||canonicalJson(receipt.priorityAssignment)!==canonicalJson({taskId,value:task.priority,decisionRef:provenance.decision_ref}))return null;
    return {protocol:'task-priority-verification/v1',vault_scope:vaultScope,authority_id:authorityId,project_id:projectId,task_id:taskId,value:task.priority as TaskPriorityEvidence['value'],decision_ref:provenance.decision_ref,source_operation_id:provenance.source_operation_id,source_issuer_id:parts[3],operation_signature:receipt.signature,revision:receipt.revision};
  }
  async journal(vaultScope: string, authorityId: string): Promise<TaskAuthorityDurableJournal> {
    if (!isDesktop()) throw new Error('authority_unavailable');
    const dataPath = this.options.getDataPath(); if (!dataPath) throw new Error('authority_unavailable');
    const adapter = this.options.app.vault.adapter as unknown as { getBasePath?: () => string };
    if (typeof adapter.getBasePath !== 'function') throw new Error('authority_unavailable');
    const path = desktopRequire<typeof import('node:path')>('node:path');
    const fs = desktopRequire<typeof import('node:fs')>('node:fs').promises;
    if (dataPath.split('/').some(segment => !segment || segment === '.' || segment === '..') || path.isAbsolute(dataPath)) throw new Error('authority_unavailable');
    const vault = await fs.realpath(adapter.getBasePath());
    const root = await fs.realpath(path.join(vault, dataPath));
    if (!root.startsWith(vault + path.sep)) throw new Error('authority storage escapes vault');
    const authorityRoot = path.join(root, 'task-authority');
    await fs.mkdir(authorityRoot, { recursive: true });
    const rootHandle=await fs.open(root,'r');try{await rootHandle.sync();}finally{await rootHandle.close();}
    if (await fs.realpath(authorityRoot) !== authorityRoot) throw new Error('authority storage symlink');
    return new TaskAuthorityDurableJournal(path.join(authorityRoot, await authorityHash([vaultScope, authorityId])));
  }
  async assertLegacyMutationAllowed(projectId: string): Promise<void> {
    // Read the source at the guard, not just a cache that may be rebuilding or
    // waiting for the admission event's post-fsync projection.
    const dataPath = this.options.getDataPath(); if (!dataPath) throw new Error('authority_unavailable');
    for (const events of await readAuthorityJournals(this.options.app, dataPath)) {
      this.validateHistory(events);
      if (events.some(e => e.type === 'project_coordination_committed' && e.projectId === projectId && e.state.admitted)) throw new Error('protocol_incompatible: admitted project requires authority');
    }
  }
  async assertProjectScope(projectId:string,vaultScope:string,authorityId:string):Promise<void> {
    const rows=await this.options.sqliteCache.query<{vaultScope:string;authorityId:string}>('SELECT vaultScope,authorityId FROM task_coordination_state WHERE projectId=?',[projectId]);
    if(rows.some(row=>row.vaultScope!==vaultScope||row.authorityId!==authorityId))throw new Error('fence_rejected');
  }
  async getState(projectId: string): Promise<AuthorityProjectState | null> {
    const rows = await this.options.sqliteCache.query<{ stateJson: string }>('SELECT stateJson FROM task_coordination_state WHERE projectId = ?', [projectId]);
    if (rows.length > 1) throw new Error('authority_unavailable');
    return rows.length ? JSON.parse(rows[0].stateJson) as AuthorityProjectState : null;
  }
  async isAdmitted(projectId: string): Promise<boolean> { return (await this.getState(projectId))?.admitted === true; }
  async getReceipt(projectId: string, issuerId: string, operationId: string): Promise<AuthorityReceipt | null> {
    const row = await this.options.sqliteCache.queryOne<{ resultJson: string }>('SELECT resultJson FROM task_coordination_receipts WHERE projectId=? AND issuerId=? AND operationId=?', [projectId, issuerId, operationId]);
    return row ? JSON.parse(row.resultJson) as AuthorityReceipt : null;
  }
  replay(): Promise<void> {
    if (this.replayPromise) return this.replayPromise;
    this.replayPromise = this.replayAll().finally(() => { this.replayPromise = null; }); return this.replayPromise;
  }
  private async replayAll(): Promise<void> {
    const dataPath = this.options.getDataPath();
    if (!dataPath) throw new Error('authority canonical storage unavailable');
    const journals = await readAuthorityJournals(this.options.app, dataPath);
    const projects = new Set<string>();
    for (const events of journals) { this.validateHistory(events); for (const event of events) if (event.type === 'project_coordination_committed') { projects.add(event.projectId); await this.apply(event); } }
    const projected = await this.options.sqliteCache.query<{ projectId: string }>('SELECT projectId FROM task_coordination_state');
    if (projected.some(row => !projects.has(row.projectId))) throw new Error('authority journal disappeared');
    for (const project of projects) { const state = await this.getState(project); if (state?.admitted && await projectHash(this.options.sqliteCache, project) !== state.operationalHash) throw new Error('authority operational base diverged'); }
  }
  validateHistory(events: AuthorityJournalEvent[]): void {
    let epoch = 0; let scope: string | undefined; let authority: string | undefined;
    const states = new Map<string, AuthorityProjectState>(); const receipts = new Map<string, AuthorityReceipt>(); const seenEvents=new Map<string,string>();
    for (const event of events) {
      if (!event || typeof event !== 'object' || !event.vaultScope || !event.authorityId) throw new Error('invalid authority event');
      scope ??= event.vaultScope; authority ??= event.authorityId;
      if (scope !== event.vaultScope || authority !== event.authorityId) throw new Error('authority event scope mismatch');
      if (event.type === 'task_authority_activated') {
        if (event.protocol !== 'task-authority-activation/v1' || event.epoch !== epoch + 1 || !/^[a-f0-9]{64}$/.test(event.tokenHash)) throw new Error('authority activation epoch gap');
        epoch = event.epoch; continue;
      }
      if (event.type !== 'project_coordination_committed' || event.protocol !== 'task-coordination-event/v1' || !epoch || !event.state || !event.receipt || !Array.isArray(event.delta) || !event.projectId || !event.id || !event.issuerId || !event.operationId || !/^[a-f0-9]{64}$/.test(event.signature)) throw new Error('invalid coordination event');
      if (event.operationKey !== key(event.issuerId, event.operationId) || event.receipt.signature !== event.signature || event.receipt.revision !== event.revision || event.state.epoch > epoch) throw new Error('coordination receipt identity mismatch');
      const receiptKey = JSON.stringify([event.projectId, event.operationKey]); const old = receipts.get(receiptKey);
      if (old) { if (canonicalJson(old) !== canonicalJson(event.receipt) || seenEvents.get(receiptKey)!==canonicalJson(event)) throw new Error('conflicting coordination receipt'); continue; }
      const previous = states.get(event.projectId);
      if (event.previousRevision !== (previous?.revision ?? 0) || !Number.isSafeInteger(event.revision) || event.revision !== event.previousRevision + (event.receipt.error ? 0 : 1) || event.state.revision !== event.revision) throw new Error('coordination revision gap');
      if (previous?.admitted && previous.baselineHash !== event.state.baselineHash) throw new Error('coordination baseline mismatch');
      if (event.receipt.error && (event.delta.length || (previous && canonicalJson(previous) !== canonicalJson(event.state)))) throw new Error('rejected coordination event changed state');
      if (!previous?.admitted && !event.receipt.error && (!event.state.admitted || event.receipt.result?.status !== 'admitted' || event.state.baselineHash !== event.state.operationalHash)) throw new Error('missing coordination admission');
      if (event.delta.some(delta => (delta as {type: string}).type === 'project_coordination_committed')) throw new Error('nested coordination event');
      for(const lease of Object.values(event.state.leases)){
        if(lease.subject){if(lease.subject.kind!=='closure'||!lease.subject.closure_id||!lease.subject.step||lease.taskId!==undefined)throw new Error('invalid closure lease subject');}
        else if(typeof lease.taskId!=='string'||!lease.taskId)throw new Error('unit lease missing task identity');
      }
      receipts.set(receiptKey, event.receipt);seenEvents.set(receiptKey,canonicalJson(event)); states.set(event.projectId, event.state);
    }
  }
  async apply(event: CoordinationCommittedEvent): Promise<void> {
    const { sqliteCache: cache, queryCache } = this.options;
    await this.assertProjectScope(event.projectId,event.vaultScope,event.authorityId);
    const known=await this.getReceipt(event.projectId,event.issuerId,event.operationId);if(known){if(canonicalJson(known)!==canonicalJson(event.receipt))throw new Error('conflicting coordination projection');return;}
    await cache.transaction(async () => {
      const old = await this.getReceipt(event.projectId, event.issuerId, event.operationId);
      if (old) { if (canonicalJson(old) !== canonicalJson(event.receipt)) throw new Error('conflicting coordination projection'); return; }
      const previous = await this.getState(event.projectId);
      if ((previous?.revision ?? 0) !== event.previousRevision) throw new Error('coordination projection revision gap');
      if (!previous && event.state.admitted && await projectHash(cache, event.projectId) !== event.state.baselineHash) throw new Error('coordination baseline mismatch');
      const applier = new TaskEventApplier(cache);
      // Capability is a private closure: public apply() always enforces the
      // legacy guard; only this canonical path obtains the internal applier.
      await applier.applyCoordinatedDelta(event);
      if (await projectHash(cache, event.projectId) !== event.state.operationalHash) throw new Error('coordination delta readback mismatch');
      await cache.run('INSERT OR REPLACE INTO task_coordination_state (vaultScope,authorityId,projectId,revision,epoch,baselineHash,stateJson) VALUES (?,?,?,?,?,?,?)', [event.vaultScope,event.authorityId,event.projectId,event.revision,event.state.epoch,event.state.baselineHash,JSON.stringify(event.state)]);
      await cache.run('INSERT INTO task_coordination_receipts (vaultScope,authorityId,projectId,issuerId,operationId,signature,revision,resultJson) VALUES (?,?,?,?,?,?,?,?)', [event.vaultScope,event.authorityId,event.projectId,event.issuerId,event.operationId,event.signature,event.revision,JSON.stringify(event.receipt)]);
      await cache.markEventApplied(event.id);
    });
    queryCache.invalidateByType('project'); queryCache.invalidateByType('task');
  }
}
