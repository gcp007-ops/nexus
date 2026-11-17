/** Pure replay gate. Caller must persist projection and event marker atomically;
 * this reducer never dispatches an external effect. */
export interface CoordinationReceipt { signature: string; result: unknown; revision: number }
export interface CoordinationProjection { revision: number; baselineHash: string; receipts: Record<string, CoordinationReceipt> }
export interface CoordinationReplayEvent { previousRevision: number; revision: number; baselineHash: string; operationKey: string; signature: string; result: unknown }
export function applyCoordinationEvent(current: CoordinationProjection, event: CoordinationReplayEvent): CoordinationProjection {
  if (event.baselineHash !== current.baselineHash) throw new Error('coordination baseline mismatch');
  if (!Number.isSafeInteger(event.previousRevision) || event.previousRevision < 0 || event.revision !== event.previousRevision + 1 || !event.operationKey || !event.signature) throw new Error('invalid coordination event');
  const old = Object.prototype.hasOwnProperty.call(current.receipts, event.operationKey) ? current.receipts[event.operationKey] : undefined;
  if (old) {
    if (old.signature !== event.signature || old.revision !== event.revision || JSON.stringify(old.result) !== JSON.stringify(event.result)) throw new Error('conflicting coordination receipt');
    return current;
  }
  if (current.revision !== event.previousRevision) throw new Error('coordination revision gap');
  return { ...current, revision: event.revision, receipts: { ...current.receipts, [event.operationKey]: { signature: event.signature, result: event.result, revision: event.revision } } };
}
