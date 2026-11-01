import type {ToolRuntimeContext} from '../../../types/tools/ToolRuntimeContext';
import {BaseTool} from '../../baseTool';
import type {CommonParameters,CommonResult} from '../../../types';
import type {ToolMutationIntent} from '../../policy/ToolExecutionPolicy';
import {ToolParamValidator} from '../../validation/ToolParamValidator';
import {resolveVaultPath} from '../../../core/vaultPath';
import {ContentCasService} from '../services/ContentCasService';

interface Params extends CommonParameters {path:string;mutationId:string;expectedHash:string;expectedContent:string;content:string}
export class CasTool extends BaseTool<Params,CommonResult> {
 constructor(private readonly cas:ContentCasService){super('cas','Compare and swap','Replace an existing Markdown note only when its exact bytes match; durable mutation receipt.', '1.0.0');}
 getMutationIntent(params:Params):Promise<ToolMutationIntent>{return Promise.resolve({kind:'modify',path:resolveVaultPath(ToolParamValidator.requireString(params.path,'path'))});}
 readonly acceptsToolRuntimeContext = true as const;
 async execute(params:Params,runtime?:ToolRuntimeContext):Promise<CommonResult>{
  try{
   const context={workspaceId:ToolParamValidator.requireString(runtime?.workspaceId,'runtime workspaceId'),sessionId:ToolParamValidator.requireString(runtime?.sessionId,'runtime sessionId')};
   for(const name of ['path','mutationId','expectedHash','expectedContent','content'] as const) ToolParamValidator.requireString(params[name],name);
   return this.prepareResult(true,await this.cas.apply({...params,context}));
  }catch(error){return this.prepareResult(false,undefined,error instanceof Error?error.message:String(error));}
 }
 getParameterSchema(){return this.getMergedSchema({type:'object',properties:{
  path:{type:'string',description:'Existing Markdown note path, relative to vault.'},
  mutationId:{type:'string',description:'Stable command identity. Reuse only for the same exact mutation.'},
  expectedHash:{type:'string',description:'SHA-256 of the exact UTF-8 expectedContent bytes.'},
  expectedContent:{type:'string',description:'Exact current text, including BOM and CRLF. Use transport values or a file.'},
  content:{type:'string',description:'Exact replacement text. No line-ending or Unicode normalization.'}
 },required:['path','mutationId','expectedHash','expectedContent','content']});}
}
