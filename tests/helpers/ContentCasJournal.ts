import type { IToolOperationRepository, CompleteToolOperationData, FinishToolOperationData } from '../../src/database/repositories/interfaces/IToolOperationRepository';
import type { StartToolOperationData, ToolOperationReceipt } from '../../src/types/tools/ToolOperationTypes';

export class Journal implements IToolOperationRepository {
  readonly rows = new Map<string, ToolOperationReceipt>();
  crashOnComplete = false;
  async getById(id: string, _ws: string) { return this.rows.get(id) ?? null; }
  async start(data: StartToolOperationData) {
    if (this.rows.has(data.operationId)) return false;
    this.rows.set(data.operationId, { ...data, status: 'started', resultTruncated: false, startedAt: 1, updatedAt: 1 });return true;
  }
  async complete(data: CompleteToolOperationData) {
    if (this.crashOnComplete) throw new Error('crash_after_effect');
    const old = this.rows.get(data.operationId);if (!old) throw new Error('missing start');
    this.rows.set(data.operationId, {...old,...data,status:'completed'});
  }
  async fail(data: FinishToolOperationData) { const row = this.rows.get(data.operationId);if (row) this.rows.set(data.operationId,{...row,status:'failed',error:data.error}); }
  async markIndeterminate(data: FinishToolOperationData) { const row = this.rows.get(data.operationId);if (row) this.rows.set(data.operationId,{...row,status:'indeterminate',error:data.error}); }
}

