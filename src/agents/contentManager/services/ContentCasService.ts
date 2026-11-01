import { App, TFile } from 'obsidian';
import type { ToolContext } from '../../../types/mcp/AgentTypes';
import { tryResolveVaultPath, resolveVaultPath } from '../../../core/vaultPath';
import { VaultOperations } from '../../../core/VaultOperations';
import type { IToolOperationRepository } from '../../../database/repositories/interfaces/IToolOperationRepository';
import type { ToolOperationReceipt } from '../../../types/tools/ToolOperationTypes';
import type { ToolOperationPersistenceProvider } from '../../toolManager/services/ToolOperationService';

export type CasIdentity = Pick<ToolContext, 'workspaceId' | 'sessionId'>;
export interface CasParams {
  path: string; mutationId: string; expectedHash: string;
  expectedContent: string; content: string; context: CasIdentity;
}
export interface CasReceipt {
  operation_id: string; path: string; old_hash: string; new_hash: string;
  outcome: 'applied' | 'recovered';
}
interface Metadata { path: string; mutationId: string; expectedHash: string; newHash: string }
export interface CasStatus { status: 'missing' | 'indeterminate' | 'failed' | 'completed' | 'recovered'; receipt: CasReceipt | null }

const queues = new WeakMap<App['vault'], Map<string, Promise<void>>>();
const LIMIT = 2 * 1024 * 1024;
export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const result = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Exact-byte precondition inside Vault.process. Durable claims and receipts use
 * the existing JSONL-first operation repository, never a second journal/cache.
 * A recovered outcome proves intended bytes are present, not who wrote them.
 */
export class ContentCasService {
  constructor(private readonly app: App, private readonly persistence?: ToolOperationPersistenceProvider) {}

  private async repository(): Promise<IToolOperationRepository> {
    const store = await this.persistence?.();
    const ready = store && (store.waitForQueryReady ? await store.waitForQueryReady() : store.isReady());
    if (!ready || !store.operations) throw new Error('cas_storage_not_ready');
    return store.operations;
  }

  private validateIdentity(id: string, context: CasIdentity): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('cas_mutation_id_invalid');
    if (!context || typeof context.workspaceId !== 'string' || !context.workspaceId.trim() ||
        typeof context.sessionId !== 'string' || !context.sessionId.trim()) throw new Error('cas_context_required');
  }

  private async journalId(id: string, context: CasIdentity): Promise<string> {
    return 'content-cas:v1:' + await sha256Text(JSON.stringify([context.workspaceId, id]));
  }

  private async signature(meta: Metadata): Promise<string> {
    return sha256Text(JSON.stringify([meta.path, meta.mutationId, meta.expectedHash, meta.newHash]));
  }

  private metadata(record: ToolOperationReceipt, context: CasIdentity): Metadata {
    if (record.workspaceId !== context.workspaceId) throw new Error('cas_workspace_conflict');
    const parsed: unknown = JSON.parse(record.commandSummary);
    if (!parsed || typeof parsed !== 'object') throw new Error('cas_receipt_invalid');
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.path !== 'string' || typeof obj.mutationId !== 'string' ||
        typeof obj.expectedHash !== 'string' || typeof obj.newHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(obj.expectedHash) || !/^[a-f0-9]{64}$/.test(obj.newHash)) throw new Error('cas_receipt_invalid');
    return { path: obj.path, mutationId: obj.mutationId, expectedHash: obj.expectedHash, newHash: obj.newHash };
  }

  private file(path: string): TFile {
    const resolved = tryResolveVaultPath(path);
    if (!resolved.ok || resolved.path !== path || !path.endsWith('.md')) throw new Error('cas_path_invalid');
    const file = this.app.vault.getAbstractFileByPath(resolved.path);
    if (!(file instanceof TFile)) throw new Error('cas_file_missing');
    return file;
  }

  private receipt(meta: Metadata, outcome: CasReceipt['outcome']): CasReceipt {
    return { operation_id: meta.mutationId, path: meta.path, old_hash: meta.expectedHash, new_hash: meta.newHash, outcome };
  }

  private async fileHash(file: TFile): Promise<string> {
    // Vault.read strips a UTF-8 BOM in real Obsidian. Identity is physical bytes.
    const digest = await crypto.subtle.digest('SHA-256', await this.app.vault.readBinary(file));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private async currentStatus(record: ToolOperationReceipt, context: CasIdentity): Promise<CasStatus> {
    const meta = this.metadata(record, context);
    if (record.signature !== await this.signature(meta)) throw new Error('cas_receipt_invalid');
    if (record.status === 'failed') return {status: 'failed', receipt: null};
    const current = await this.fileHash(this.file(meta.path));
    if (current === meta.newHash) {
      let outcome: CasReceipt['outcome'] = 'recovered';
      if (record.status === 'completed') {
        const saved: unknown = JSON.parse(record.resultJson ?? 'null');
        if (!saved || typeof saved !== 'object' || !('outcome' in saved) ||
            (saved.outcome !== 'applied' && saved.outcome !== 'recovered')) throw new Error('cas_receipt_invalid');
        outcome = saved.outcome;
      }
      return { status: record.status === 'completed' ? 'completed' : 'recovered', receipt: this.receipt(meta, outcome) };
    }
    // Old bytes may be an external restoration after an unrecorded effect.
    // They never prove that this operation did not already write once.
    if (record.status !== 'completed' && current === meta.expectedHash) return {status: 'indeterminate', receipt: null};
    throw new Error('cas_conflict: current content differs from the recorded operation');
  }

  async status(mutationId: string, context: CasIdentity): Promise<CasStatus> {
    this.validateIdentity(mutationId, context);
    const repo = await this.repository();
    const record = await repo.getById(await this.journalId(mutationId, context), context.workspaceId);
    return record ? this.currentStatus(record, context) : {status: 'missing', receipt: null};
  }

  private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    let map = queues.get(this.app.vault);
    if (!map) { map = new Map(); queues.set(this.app.vault, map); }
    const previous = map.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    map.set(key, tail);
    await previous;
    try { return await work(); }
    finally { release(); if (map.get(key) === tail) map.delete(key); }
  }

  async apply(params: CasParams): Promise<CasReceipt> {
    this.validateIdentity(params.mutationId, params.context);
    if (typeof params.path !== 'string' || typeof params.expectedContent !== 'string' || typeof params.content !== 'string' ||
        new TextEncoder().encode(params.expectedContent).length > LIMIT || new TextEncoder().encode(params.content).length > LIMIT) throw new Error('cas_content_invalid');
    this.file(params.path);
    if (typeof params.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedHash) ||
        await sha256Text(params.expectedContent) !== params.expectedHash) throw new Error('cas_expected_hash_invalid');
    const meta: Metadata = {path: params.path, mutationId: params.mutationId, expectedHash: params.expectedHash, newHash: await sha256Text(params.content)};
    if (meta.expectedHash === meta.newHash) throw new Error('cas_no_change');
    return this.serialized(meta.path, async () => {
      const repo = await this.repository();
      const id = await this.journalId(meta.mutationId, params.context);
      const signature = await this.signature(meta);
      let old = await repo.getById(id, params.context.workspaceId);
      let ownClaim = false;
      if (!old) {
        const claimed = await repo.start({operationId:id,signature,origin:'workflow',workspaceId:params.context.workspaceId,
          sessionId:params.context.sessionId,replayable:true,replayPolicy:'deduplicate',commandSummary:JSON.stringify(meta)});
        ownClaim = claimed;
        old = await repo.getById(id, params.context.workspaceId);
        if (!claimed && !old) throw new Error('cas_claim_unavailable');
      }
      if (!old || old.workspaceId !== params.context.workspaceId || old.signature !== signature) throw new Error('cas_mutation_conflict');
      if (old.status === 'failed') throw new Error('cas_prior_failure');
      const finish = async (receipt: CasReceipt) => {
        await repo.complete({operationId:id,workspaceId:params.context.workspaceId,signature,resultJson:JSON.stringify(receipt),resultTruncated:false});
        return receipt;
      };
      if (!ownClaim || old.status === 'completed') {
        const status = await this.currentStatus(old, params.context);
        if (status.receipt) return old.status === 'completed' ? status.receipt : finish(status.receipt);
        throw new Error('cas_effect_indeterminate: no automatic replay of an existing claim');
      }
      const file = this.file(meta.path);
      let accepted = false;
      try {
        await VaultOperations.processNote(this.app.vault, resolveVaultPath(meta.path), current => {
          if (current !== params.expectedContent) throw new Error('cas_conflict: precondition changed');
          accepted = true;
          return params.content;
        });
      } catch (error) {
        // A failed response after accepting the callback may hide a real write.
        // Recovery observes the intended bytes; it never dispatches again.
        if (accepted && await this.fileHash(file) === meta.newHash) return finish(this.receipt(meta,'recovered'));
        if (accepted) await repo.markIndeterminate({operationId:id,workspaceId:params.context.workspaceId,signature,error:'cas_effect_indeterminate'});
        else await repo.fail({operationId:id,workspaceId:params.context.workspaceId,signature,error:'cas_conflict'});
        throw error;
      }
      if (await this.fileHash(file) !== meta.newHash) throw new Error('cas_conflict: readback changed');
      return finish(this.receipt(meta,'applied'));
    });
  }
}
