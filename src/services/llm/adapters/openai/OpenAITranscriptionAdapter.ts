import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../../types/VoiceTypes';
import { buildMultipartFormData } from '../../utils/MultipartFormDataBuilder';
import { parseWhisperResponse } from '../../utils/WhisperResponseParser';

export class OpenAITranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openai';
  private readonly endpoint = 'https://api.openai.com/v1/audio/transcriptions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const fields = [
      {
        name: 'file',
        value: chunk.data,
        filename: this.buildChunkFileName(request.fileName, chunk.mimeType),
        contentType: chunk.mimeType
      },
      { name: 'model', value: request.model }
    ];

    const wantsWords = request.model === 'whisper-1' && request.requestWordTimestamps === true;
    if (request.prompt?.trim()) {
      fields.push({ name: 'prompt', value: request.prompt.trim() });
    }

    if (request.model === 'whisper-1') {
      fields.push({ name: 'response_format', value: 'verbose_json' });
      fields.push({ name: 'timestamp_granularities[]', value: 'segment' });
      if (wantsWords) {
        fields.push({ name: 'timestamp_granularities[]', value: 'word' });
      }
    } else {
      fields.push({ name: 'response_format', value: 'json' });
    }

    const { body, contentType } = buildMultipartFormData(fields);
    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': contentType
      },
      body
    });

    if (response.status !== 200) {
      throw new Error(`OpenAI transcription failed: HTTP ${response.status}`);
    }

    return parseWhisperResponse(response.json as unknown, chunk.durationSeconds);
  }
}

