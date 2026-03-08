/**
 * Google Gemini Adapter with true streaming support
 * Implements Google Gemini REST requests with buffered SSE replay.
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  SearchResult
} from '../types';
import { GOOGLE_MODELS, GOOGLE_DEFAULT_MODEL } from './GoogleModels';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { ReasoningPreserver } from '../shared/ReasoningPreserver';
import { SchemaValidator } from '../../utils/SchemaValidator';
import { ThinkingEffortMapper } from '../../utils/ThinkingEffortMapper';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

export class GoogleAdapter extends BaseAdapter {
  readonly name = 'google';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GOOGLE_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      try {
        // Tool execution requires streaming - use generateStreamAsync instead
        if (options?.tools && options.tools.length > 0) {
          throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
        }

        // Use basic message generation
        return await this.generateWithBasicMessages(prompt, options);
      } catch (error) {
        this.handleError(error, 'generation');
      }
    });
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    let request: any;
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('google', options.webSearch);
      }

      // Build contents - use conversation history if provided (for tool continuations)
      let contents: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        contents = options.conversationHistory;
      } else {
        // Ensure prompt is not empty
        if (!prompt || !prompt.trim()) {
          prompt = 'Continue the conversation';
        }
        contents = [{
          role: 'user',
          parts: [{ text: prompt }]
        }];
      }

      // Determine thinking budget based on options or tools
      const effort = options?.thinkingEffort || 'medium';
      const googleThinkingParams = ThinkingEffortMapper.getGoogleParams({ enabled: true, effort });
      const thinkingBudget = googleThinkingParams?.thinkingBudget || 8192;

      // Build config object with all generation settings
      const config: any = {
        generationConfig: {
          // Use temperature 0 when tools are provided for more deterministic function calling
          temperature: (options?.tools && options.tools.length > 0) ? 0 : (options?.temperature ?? 0.7),
          maxOutputTokens: options?.maxTokens || 4096,
          topK: 40,
          topP: 0.95,
          // Enable thinking mode when tools are present or explicitly requested
          // Gemini 2.5 Flash supports 0-24576 token thinking budget
          ...((options?.enableThinking || (options?.tools && options.tools.length > 0)) && {
            thinkingConfig: { thinkingBudget }
          })
        }
      };

      // Add system instruction if provided (inside config)
      if (options?.systemPrompt) {
        config.systemInstruction = {
          parts: [{ text: options.systemPrompt }]
        };
      }

      // Add web search grounding if requested (must be before other tools)
      if (options?.webSearch) {
        config.tools = config.tools || [];
        config.tools.push({ googleSearch: {} });
      }

      // Add tools if provided (inside config)
      if (options?.tools && options.tools.length > 0) {
        const convertedTools = this.convertTools(options.tools);

        // Merge with existing tools array if web search was added
        if (config.tools && config.tools.length > 0) {
          config.tools.push(...convertedTools);
        } else {
          config.tools = convertedTools;
        }

        // Validate each tool schema before sending to Google
        let validationFailures = 0;
        for (const toolWrapper of config.tools) {
          const functionDeclarations = toolWrapper.functionDeclarations;
          if (functionDeclarations) {
            for (const tool of functionDeclarations) {
              const validation = SchemaValidator.validateGoogleSchema(tool.parameters, tool.name);
              if (!validation.valid) {
                validationFailures++;
                console.error(`[Google Adapter] ⚠️ Schema validation failed for tool "${tool.name}":`);
                console.error(`[Google Adapter]    ${validation.error}`);
                console.error(`[Google Adapter]    This may cause MALFORMED_FUNCTION_CALL errors`);
              }
            }
          }
        }

        if (validationFailures > 0) {
          console.error(`[Google Adapter] ❌ ${validationFailures} tool(s) have schema validation issues`);
        }

        // Add function calling config - let model decide when to use tools
        config.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO' // Model decides when tools are appropriate
          }
        };

      }

      // Build final request with config wrapper
      const request: any = {
        model: options?.model || this.currentModel,
        contents: contents,
        config: config
      };

      const nodeStream = await this.requestStream({
        url: this.buildGenerateContentUrl(request.model, true),
        operation: 'streaming generation',
        method: 'POST',
        headers: this.buildGoogleHeaders(),
        body: JSON.stringify(this.buildGenerateContentBody(request)),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Google',
        extractContent: (chunk) => {
          // Surface error finish reasons as user-facing content before the stream ends
          const finishReason = chunk.candidates?.[0]?.finishReason;
          if (finishReason === 'MALFORMED_FUNCTION_CALL') {
            return '\n\n[Error: MALFORMED_FUNCTION_CALL — Google rejected a tool call due to a ' +
              'schema mismatch. The model generated arguments that don\'t match the tool\'s ' +
              'parameter schema. Common causes: required fields missing from schema, unsupported ' +
              'JSON Schema features (e.g. oneOf, $ref), or overly complex nested objects. ' +
              'Check tool definitions and simplify schemas if needed.]';
          }
          if (finishReason === 'SAFETY') {
            return '\n\n[Error: SAFETY — Google blocked this response due to safety filters. ' +
              'The content was flagged as potentially harmful. Try rephrasing your request.]';
          }
          if (finishReason === 'RECITATION') {
            return '\n\n[Error: RECITATION — Google blocked this response because it contained ' +
              'text too similar to copyrighted material.]';
          }

          const parts = chunk.candidates?.[0]?.content?.parts || [];
          return this.extractTextFromParts(parts) || null;
        },
        extractToolCalls: (chunk) => {
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          const toolCalls = parts
            .filter((part: any) => part.functionCall)
            .map((part: any, index: number) => {
              const toolCall: any = {
                index,
                id: `${part.functionCall.name}_${index}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {})
                }
              };

              const thoughtSignature = ReasoningPreserver.extractThoughtSignatureFromPart(part);
              if (thoughtSignature) {
                toolCall.thought_signature = thoughtSignature;
              }

              return toolCall;
            });

          return toolCalls.length > 0 ? toolCalls : null;
        },
        extractFinishReason: (chunk) => {
          const finishReason = chunk.candidates?.[0]?.finishReason;
          if (!finishReason) return null;

          // M4: Map Google finish reasons properly.
          // Error content for MALFORMED_FUNCTION_CALL, SAFETY, RECITATION is
          // surfaced in extractContent above; here we signal stream completion.
          switch (finishReason) {
            case 'STOP':
              return 'stop';
            case 'MAX_TOKENS':
              return 'length';
            case 'MALFORMED_FUNCTION_CALL':
            case 'SAFETY':
            case 'RECITATION':
            case 'OTHER':
            default:
              return 'stop';
          }
        },
        extractUsage: (chunk) => chunk.usageMetadata || null,
        extractReasoning: (chunk) => {
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          const thinkingText = parts
            .map((part: any) => part.thought || part.thinking || '')
            .filter(Boolean)
            .join('');
          if (thinkingText) {
            return { text: thinkingText, complete: false };
          }
          return null;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error: any) {
      console.error('[Google Adapter] ❌❌❌ STREAMING ERROR:', error);
      console.error('[Google Adapter] Error details:', {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      });
      throw error;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return GOOGLE_MODELS.map(model => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking,
        costPer1kTokens: {
          input: model.inputCostPerMillion / 1000,
          output: model.outputCostPerMillion / 1000
        },
        pricing: {
          inputPerMillion: model.inputCostPerMillion,
          outputPerMillion: model.outputCostPerMillion,
          currency: 'USD',
          lastUpdated: new Date().toISOString()
        }
      }));
    } catch (error) {
      this.handleError(error, 'listing models');
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 2097152,
      supportedFeatures: [
        'messages',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'thinking_mode'
      ]
    };
  }

  /**
   * Generate using basic message API without tools
   */
  private async generateWithBasicMessages(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    // Validate web search support
    if (options?.webSearch) {
      WebSearchUtils.validateWebSearchRequest('google', options.webSearch);
    }

    const request: any = {
      model: options?.model || this.currentModel,
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        topK: 40,
        topP: 0.95
      }
    };

    // Add system instruction if provided
    if (options?.systemPrompt) {
      request.systemInstruction = {
        parts: [{ text: options.systemPrompt }]
      };
    }

    // Add web search grounding if requested
    // Google Search grounding uses special googleSearch tool, not a function
    if (options?.webSearch) {
      request.tools = [{ googleSearch: {} }];
    }

    const response = await this.request<any>({
      url: this.buildGenerateContentUrl(request.model, false),
      operation: 'generation',
      method: 'POST',
      headers: this.buildGoogleHeaders(),
      body: JSON.stringify(this.buildGenerateContentBody(request)),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Google generation failed: HTTP ${response.status}`);
    const responseJson = response.json;

    const extractedUsage = this.extractUsage(responseJson);
    const finishReason = this.mapFinishReason(responseJson.candidates?.[0]?.finishReason);
    const toolCalls = this.extractToolCalls(responseJson);

    // Extract web search results if web search was enabled
    const webSearchResults = options?.webSearch
      ? this.extractGoogleSources(responseJson)
      : undefined;

    const textContent = this.extractTextFromParts(responseJson.candidates?.[0]?.content?.parts || []);

    return await this.buildLLMResponse(
      textContent,
      options?.model || this.currentModel,
      extractedUsage,
      { webSearchResults },
      finishReason,
      toolCalls
    );
  }

  // Private methods
  private convertTools(tools: any[]): any[] {
    // Gemini uses functionDeclarations wrapper (NOT OpenAI's flat array)
    return [{
      functionDeclarations: tools.map(tool => {
        if (tool.type === 'function') {
          // Handle both nested (Chat Completions) and flat (Responses API) formats
          const toolDef = tool.function || tool;
          return {
            name: toolDef.name,
            description: toolDef.description,
            parameters: this.sanitizeSchemaForGoogle(toolDef.parameters || toolDef.input_schema)
          };
        }
        return tool;
      })
    }];
  }

  /**
   * Sanitize JSON Schema for Google's simplified schema format
   * Delegates to SchemaValidator utility
   */
  private sanitizeSchemaForGoogle(schema: any): any {
    return SchemaValidator.sanitizeSchemaForGoogle(schema);
  }

  private buildGoogleHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey
    };
  }

  private buildGenerateContentUrl(model: string, stream: boolean): string {
    const encodedModel = encodeURIComponent(model);
    return stream
      ? `${this.baseUrl}/models/${encodedModel}:streamGenerateContent?alt=sse`
      : `${this.baseUrl}/models/${encodedModel}:generateContent`;
  }

  private buildGenerateContentBody(request: any): Record<string, unknown> {
    return {
      contents: request.contents,
      generationConfig: request.config?.generationConfig || request.generationConfig,
      systemInstruction: request.config?.systemInstruction || request.systemInstruction,
      tools: request.config?.tools || request.tools,
      toolConfig: request.config?.toolConfig || request.toolConfig
    };
  }

  private extractToolCalls(response: any): any[] {
    // Extract from response.candidates[0].content.parts
    const parts = response.candidates?.[0]?.content?.parts || [];
    const toolCalls: any[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name + '_' + Date.now(),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    return toolCalls;
  }

  private extractTextFromParts(parts: any[]): string {
    return parts
      .filter(part => part.text)
      .map(part => part.text)
      .join('');
  }

  /**
   * Extract search results from Google response
   * Google may include sources in grounding chunks or tool results
   */
  private extractGoogleSources(response: any): SearchResult[] {
    try {
      const sources: SearchResult[] = [];

      // Check for grounding metadata (Google's web search citations)
      if (response.groundingMetadata?.webSearchQueries) {
        const groundingChunks = response.groundingMetadata.groundingChunks || [];
        for (const chunk of groundingChunks) {
          const result = WebSearchUtils.validateSearchResult({
            title: chunk.title || 'Unknown Source',
            url: chunk.web?.uri || chunk.uri,
            date: chunk.publishedDate
          });
          if (result) sources.push(result);
        }
      }

      // Check for function call results (if google_search tool was used)
      const functionCalls = response.functionCalls || [];
      for (const call of functionCalls) {
        if (call.name === 'google_search' && call.response) {
          try {
            const searchData = call.response;
            if (searchData.results && Array.isArray(searchData.results)) {
              const extractedSources = WebSearchUtils.extractSearchResults(searchData.results);
              sources.push(...extractedSources);
            }
          } catch (error) {
          }
        }
      }

      return sources;
    } catch (error) {
      return [];
    }
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'STOP': 'stop',
      'MAX_TOKENS': 'length',
      'SAFETY': 'content_filter',
      'RECITATION': 'content_filter',
      'MALFORMED_FUNCTION_CALL': 'stop',
      'OTHER': 'stop'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: any): any {
    const usage = response.usageMetadata || response.usage;
    if (usage) {
      return {
        promptTokens: usage.promptTokenCount || usage.inputTokens || 0,
        completionTokens: usage.candidatesTokenCount || usage.outputTokens || 0,
        totalTokens: usage.totalTokenCount || usage.totalTokens || 0
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = GOOGLE_MODELS.find(m => m.apiName === modelId);
    if (!model) return undefined;
    
    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return null;
    
    return {
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    };
  }
}
