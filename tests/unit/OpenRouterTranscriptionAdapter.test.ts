/**
 * OpenRouterTranscriptionAdapter Unit Tests
 *
 * Tests the chat completions pattern: JSON body with input_audio content block,
 * Bearer auth, optional HTTP-Referer and X-Title headers.
 */

import { __setRequestUrlMock } from 'obsidian';
import { OpenRouterTranscriptionAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest
} from '../../src/services/llm/types/VoiceTypes';

function makeChunk(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    data: new ArrayBuffer(8),
    mimeType: 'audio/mpeg',
    startSeconds: 0,
    durationSeconds: 30,
    ...overrides
  };
}

function makeRequest(
  overrides: Partial<TranscriptionRequest & { provider: TranscriptionProvider; model: string }> = {}
): TranscriptionRequest & { provider: TranscriptionProvider; model: string } {
  return {
    audioData: new ArrayBuffer(8),
    mimeType: 'audio/mpeg',
    fileName: 'test.mp3',
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    ...overrides
  };
}

describe('OpenRouterTranscriptionAdapter', () => {
  // ── Request construction ────────────────────────────────────────────

  describe('request construction', () => {
    it('sends to OpenRouter chat completions endpoint', async () => {
      let capturedUrl = '';
      const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('includes Bearer auth header', async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['Authorization']).toBe('Bearer or-test');
    });

    it('includes HTTP-Referer when configured', async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new OpenRouterTranscriptionAdapter({
        apiKey: 'or-test',
        httpReferer: 'https://example.com'
      });
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['HTTP-Referer']).toBe('https://example.com');
    });

    it('includes X-Title when configured', async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new OpenRouterTranscriptionAdapter({
        apiKey: 'or-test',
        xTitle: 'Nexus'
      });
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['X-Title']).toBe('Nexus');
    });

    it('omits HTTP-Referer and X-Title when not configured', async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['HTTP-Referer']).toBeUndefined();
      expect(capturedHeaders['X-Title']).toBeUndefined();
    });

    it('sends input_audio content block with base64 data and format', async () => {
      let parsedBody: unknown = null;
      const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk({ mimeType: 'audio/wav' }), makeRequest());
      const body = parsedBody as {
        messages: Array<{ content: Array<{ type: string; input_audio?: { format: string; data: string } }> }>;
        model: string;
        stream: boolean;
        temperature: number;
      };

      const audioBlock = body.messages[0].content[1];
      expect(audioBlock.type).toBe('input_audio');
      expect(audioBlock.input_audio?.format).toBe('wav');
      expect(typeof audioBlock.input_audio?.data).toBe('string');
      expect(body.model).toBe('google/gemini-2.5-flash');
      expect(body.stream).toBe(false);
      expect(body.temperature).toBe(0);
    });

    it('uses custom prompt when provided', async () => {
      let parsedBody: unknown = null;
      const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { choices: [{ message: { content: 'Hi' } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest({ prompt: '  Spanish only  ' }));
      const body = parsedBody as { messages: Array<{ content: Array<{ text?: string }> }> };
      expect(body.messages[0].content[0].text).toBe('Spanish only');
    });
  });

  // ── Response parsing ────────────────────────────────────────────────

  describe('response parsing', () => {
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });

    it('extracts string content from choices', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { choices: [{ message: { content: '  Hello world  ' } }] }
      }));

      const result = await adapter.transcribeChunk(
        makeChunk({ durationSeconds: 10 }),
        makeRequest()
      );
      expect(result).toEqual([{
        startSeconds: 0,
        endSeconds: 10,
        text: 'Hello world'
      }]);
    });

    it('handles array content (multipart response)', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          choices: [{
            message: {
              content: [
                { type: 'text', text: 'Part one' },
                { type: 'text', text: 'Part two' }
              ]
            }
          }]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].text).toBe('Part one\nPart two');
    });

    it('handles array with string elements', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          choices: [{
            message: {
              content: ['First string', 'Second string']
            }
          }]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].text).toBe('First string\nSecond string');
    });

    it('returns empty array when content is empty', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { choices: [{ message: { content: '   ' } }] }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when no choices', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {}
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when content is neither string nor array', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { choices: [{ message: { content: 42 } }] }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    const adapter = new OpenRouterTranscriptionAdapter({ apiKey: 'or-test' });

    it('throws with HTTP status on non-200', async () => {
      __setRequestUrlMock(async () => ({
        status: 429,
        json: { error: { message: 'Rate limited' } }
      }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('OpenRouter transcription failed: HTTP 429');
    });
  });
});
