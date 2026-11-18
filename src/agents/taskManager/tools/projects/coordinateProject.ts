import { BaseTool } from '../../../baseTool';
import type { TaskService } from '../../services/TaskService';
import type { CoordinateProjectParameters,CoordinateProjectResult } from '../../types';
import { taskAuthorityEnvelopeSchema } from '../../authority/TaskAuthorityContracts';
import type { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
export class CoordinateProjectTool extends BaseTool<CoordinateProjectParameters,CoordinateProjectResult>{
  constructor(private readonly service:TaskService){super('coordinateProject','Coordinate project','Execute a conditional task-authority-command/v1 envelope with a caller-owned stable operation_id. Requires configured authority; never falls back to legacy writes. Host begin/record operations require authenticated host ingress.','1.0.0');}
  async execute(params:CoordinateProjectParameters):Promise<CoordinateProjectResult>{try{return {success:true,result:await this.service.getTaskAuthority().executeCommand(params.envelope)};}catch(error){return {success:false,error:error instanceof Error?error.message:'authority_unavailable'};}}
  getParameterSchema():JSONSchema{return this.getMergedSchema({type:'object',properties:{envelope:taskAuthorityEnvelopeSchema()},required:['envelope']});}
}
