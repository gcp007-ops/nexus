import type { TaskEvent, BaseStorageEvent } from '../../interfaces/StorageEvents';
import type { CommandResult, AuthorityError } from '../../../agents/taskManager/authority/TaskAuthorityContracts';
export type OperationalTaskEvent = Exclude<TaskEvent, { type: 'project_coordination_committed' }>;
export interface AuthorityLease { id: string; issuer: string; epoch: number; resources: string[]; expiresAt: number; maxLeaseMs: number; taskId: string }
export interface AuthorityEffect { id: string; operationId: string; dispatchId: string; leaseId: string; issuer: string; hostId: string; proposalHash: string; preconditionHash: string; capabilityRef: unknown; proposalRef: unknown; resources: string[]; state: 'dispatched' | 'started' | 'confirmed' | 'rejected' | 'failed' | 'indeterminate' | 'committed'; lastRevision: number; recordOperationId?: string; recordOperationSignature?: string; recordRevision?: number; receiptRef?: { artifact_id: string; hash: string } }
export interface AuthorityProjectState { admitted: boolean; revision: number; epoch: number; baselineHash: string; operationalHash: string; leases: Record<string, AuthorityLease>; effects: Record<string, AuthorityEffect> }
export interface PriorityAssignment { taskId: string; value: string; decisionRef: string }
export interface AuthorityReceipt { priorityAssignment?: PriorityAssignment; signature: string; revision: number; result: CommandResult | null; error: AuthorityError | null }
export interface CoordinationCommittedEvent extends BaseStorageEvent {
  type: 'project_coordination_committed'; protocol: 'task-coordination-event/v1'; vaultScope: string; authorityId: string; projectId: string;
  previousRevision: number; revision: number; operationKey: string; signature: string; issuerId: string; operationId: string;
  state: AuthorityProjectState; receipt: AuthorityReceipt; delta: OperationalTaskEvent[];
}
export interface AuthorityActivationEvent { type: 'task_authority_activated'; protocol: 'task-authority-activation/v1'; vaultScope: string; authorityId: string; epoch: number; tokenHash: string }
export type AuthorityJournalEvent = CoordinationCommittedEvent | AuthorityActivationEvent;
export interface AuthorityJournal { read(): Promise<AuthorityJournalEvent[]>; append(event: AuthorityJournalEvent): Promise<void>; activate(): Promise<void>; assertActive(): Promise<void>; deactivate(): Promise<void> }
export interface ITaskCoordinationRepository {
  replay(): Promise<void>;
  getState(projectId: string): Promise<AuthorityProjectState | null>;
  isAdmitted(projectId: string): Promise<boolean>;
  getReceipt(projectId: string, issuerId: string, operationId: string): Promise<AuthorityReceipt | null>;
}
