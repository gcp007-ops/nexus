import type {ArtifactRef} from './TaskAuthorityContracts';
import type {AuthorityEffect} from '../../../database/repositories/interfaces/ITaskCoordinationRepository';
export interface DispatchedEffectCancellation {project_id:string;effect_id:string;dispatch_id:string;operation_id:string;proof_ref:ArtifactRef}
export interface DispatchCancellationRequest {protocol:'task-dispatch-cancellation-validation/v1';vault_scope:string;authority_id:string;host_id:string;project_id:string;effect:AuthorityEffect;proof_ref:ArtifactRef}
export interface DispatchCancellationProof {protocol:'task-dispatch-cancellation-proof/v1';proof_ref:ArtifactRef;quiescence_ref:ArtifactRef;resources:string[]}
