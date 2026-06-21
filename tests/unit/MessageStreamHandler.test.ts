import { MessageStreamHandler } from '../../src/ui/chat/services/MessageStreamHandler';
import type { ChatService } from '../../src/services/chat/ChatService';
import { createConversation } from '../fixtures/chatBugs';
import { createMockChatService } from '../mocks/chatService';

describe('MessageStreamHandler', () => {
  it('clears placeholder loading state when a stream completes without text', async () => {
    const conversation = createConversation({
      messages: [
        {
          id: 'msg_ai',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          conversationId: 'conv_1',
          state: 'draft',
          isLoading: true
        }
      ]
    });
    const mockChatService = createMockChatService({ conversation });
    mockChatService.generateResponseStreaming.mockImplementation(
      (_conversationId: string, _userMessage: string, options?: { messageId?: string }) => {
        async function* stream() {
          yield {
            chunk: '',
            complete: true,
            messageId: options?.messageId || 'msg_ai'
          };
        }

        return stream();
      }
    );

    const events = {
      onStreamingUpdate: jest.fn(),
      onToolCallsDetected: jest.fn()
    };
    const handler = new MessageStreamHandler(
      mockChatService as unknown as ChatService,
      events
    );

    await handler.streamResponse(conversation, 'Prompt', 'msg_ai', {});

    expect(conversation.messages[0]).toMatchObject({
      state: 'complete',
      isLoading: false,
      content: ''
    });
    expect(events.onStreamingUpdate).toHaveBeenCalledWith('msg_ai', '', true, false);
  });
});
