import type {ToolRuntimeContext} from '../../../types/tools/ToolRuntimeContext';
import {BaseTool} from '../../baseTool';
import type {CommonParameters,CommonResult} from '../../../types';
import {ToolParamValidator} from '../../validation/ToolParamValidator';
import {ContentCasService} from '../services/ContentCasService';
interface Params extends CommonParameters {mutationId:string}
export class CasStatusTool extends BaseTool<Params,CommonResult>{
 constructor(private readonly cas:ContentCasService){super('casStatus','CAS status','Read a CAS receipt and current bytes without writing the note. Pending is not confirmation.', '1.0.0');}
 readonly acceptsToolRuntimeContext = true as const;
 async execute(params:Params,runtime?:ToolRuntimeContext):Promise<CommonResult>{
  try{
   const context={workspaceId:ToolParamValidator.requireString(runtime?.workspaceId,'runtime workspaceId'),sessionId:ToolParamValidator.requireString(runtime?.sessionId,'runtime sessionId')};
   ToolParamValidator.requireString(params.mutationId,'mutationId');
   return this.prepareResult(true,await this.cas.status(params.mutationId,context));
  }catch(error){return this.prepareResult(false,undefined,error instanceof Error?error.message:String(error));}
 }
 getParameterSchema(){return this.getMergedSchema({type:'object',properties:{mutationId:{type:'string',description:'Identity of the recorded CAS command in this workspace.'}},required:['mutationId']});}
}
