/**
 * GoogleTranscriptionAdapter Unit Tests
 *
 * Tests the multimodal audio pattern: JSON body with base64-encoded audio
 * sent to the Gemini generativeContent endpoint.
 */

import { __setRequestUrlMock } from 'obsidian';
import { GoogleTranscriptionAdapter } from '../../src/services/llm/adapters/google/GoogleTranscriptionAdapter';
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
    provider: 'google',
    model: 'gemini-2.5-flash',
    ...overrides
  };
}

describe('GoogleTranscriptionAdapter', () => {
  let adapter: GoogleTranscriptionAdapter;

  beforeEach(() => {
    adapter = new GoogleTranscriptionAdapter({ apiKey: 'google-test-key' });
    jest.clearAllMocks();
  });

  // ── Request construction ────────────────────────────────────────────

  describe('request construction', () => {
    it('sends to Gemini generateContent endpoint with model in URL', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest({ model: 'gemini-2.5-flash' }));
      expect(capturedUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
      );
    });

    it('URL-encodes the model name', async () => {
      let capturedUrl = '';
      __setRequestUrlMock(async (req) => {
        capturedUrl = req.url || '';
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest({ model: 'gemini-3-flash-preview' }));
      expect(capturedUrl).toContain('gemini-3-flash-preview');
    });

    it('sends x-goog-api-key header (not Bearer)', async () => {
      let capturedHeaders: Record<string, string> = {};
      __setRequestUrlMock(async (req) => {
        capturedHeaders = (req.headers || {}) as Record<string, string>;
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(capturedHeaders['x-goog-api-key']).toBe('google-test-key');
      expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    it('includes audio data as base64 inline_data', async () => {
      let parsedBody: unknown = null;
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk({ mimeType: 'audio/wav' }), makeRequest());
      const body = parsedBody as { contents: Array<{ parts: Array<{ inline_data?: { mime_type: string; data: string } }> }> };
      const inlineData = body.contents[0].parts[1].inline_data;
      expect(inlineData?.mime_type).toBe('audio/wav');
      expect(typeof inlineData?.data).toBe('string');
    });

    it('uses custom prompt when provided', async () => {
      let parsedBody: unknown = null;
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest({ prompt: '  Transcribe in French  ' }));
      const body = parsedBody as { contents: Array<{ parts: Array<{ text?: string }> }> };
      expect(body.contents[0].parts[0].text).toBe('Transcribe in French');
    });

    it('uses default prompt when prompt is empty', async () => {
      let parsedBody: unknown = null;
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      const body = parsedBody as { contents: Array<{ parts: Array<{ text?: string }> }> };
      expect(body.contents[0].parts[0].text).toContain('Transcribe');
    });

    it('sets temperature to 0', async () => {
      let parsedBody: unknown = null;
      __setRequestUrlMock(async (req) => {
        parsedBody = JSON.parse(req.body as string);
        return { status: 200, json: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } };
      });

      await adapter.transcribeChunk(makeChunk(), makeRequest());
      const body = parsedBody as { generationConfig: { temperature: number } };
      expect(body.generationConfig.temperature).toBe(0);
    });
  });

  // ── Response parsing ────────────────────────────────────────────────

  describe('response parsing', () => {
    it('extracts text from candidates[0].content.parts', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          candidates: [{
            content: {
              parts: [
                { text: '  Hello world  ' }
              ]
            }
          }]
        }
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

    it('joins multiple text parts with newline', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          candidates: [{
            content: {
              parts: [
                { text: 'First part' },
                { text: 'Second part' }
              ]
            }
          }]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].text).toBe('First part\nSecond part');
    });

    it('returns empty array when candidates is empty', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: { candidates: [] }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when no candidates', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {}
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('returns empty array when text is empty', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          candidates: [{
            content: {
              parts: [{ text: '   ' }]
            }
          }]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result).toEqual([]);
    });

    it('ignores non-text parts', async () => {
      __setRequestUrlMock(async () => ({
        status: 200,
        json: {
          candidates: [{
            content: {
              parts: [
                { text: 'Valid' },
                { someOtherField: 'ignored' }
              ]
            }
          }]
        }
      }));

      const result = await adapter.transcribeChunk(makeChunk(), makeRequest());
      expect(result[0].text).toBe('Valid');
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws with HTTP status on non-200', async () => {
      __setRequestUrlMock(async () => ({
        status: 403,
        json: { error: { message: 'Forbidden' } }
      }));

      await expect(
        adapter.transcribeChunk(makeChunk(), makeRequest())
      ).rejects.toThrow('Google transcription failed: HTTP 403');
    });
  });
});
