import { BaseTool } from '../../../baseTool';
import type { TaskService } from '../../services/TaskService';
import type { CoordinateProjectParameters,CoordinateProjectResult } from '../../types';
import { taskAuthorityEnvelopeSchema } from '../../authority/TaskAuthorityContracts';
import type { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
export class CoordinationStatusTool extends BaseTool<CoordinateProjectParameters,CoordinateProjectResult>{
  constructor(private readonly service:TaskService){super('coordinationStatus','Coordination status','Read a closed task-authority-query/v1 envelope. getOperation only reads a durable receipt; it never resends an uncertain effect.','1.0.0');}
  async execute(params:CoordinateProjectParameters):Promise<CoordinateProjectResult>{try{return {success:true,result:await this.service.getTaskAuthority().query(params.envelope)};}catch(error){return {success:false,error:error instanceof Error?error.message:'authority_unavailable'};}}
  getParameterSchema():JSONSchema{return this.getMergedSchema({type:'object',properties:{envelope:taskAuthorityEnvelopeSchema(true)},required:['envelope']});}
}
