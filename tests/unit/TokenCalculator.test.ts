import { TokenCalculator } from '../../src/ui/chat/utils/TokenCalculator';

describe('TokenCalculator usage normalization', () => {
  it('counts camelCase prompt/completion/total usage fields', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_1',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1,
          conversationId: 'conv_1',
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150
          }
        }
      ]
    });

    expect(tokens).toBe(150);
  });

  it('counts snake_case and anthropic-style usage fields', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_2',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1,
          conversationId: 'conv_2',
          usage: {
            prompt_tokens: 90,
            completion_tokens: 10,
            total_tokens: 100
          }
        },
        {
          id: 'msg_2',
          role: 'assistant',
          content: 'world',
          timestamp: 2,
          conversationId: 'conv_2',
          usage: {
            input_tokens: 70,
            output_tokens: 20
          }
        }
      ]
    });

    expect(tokens).toBe(190);
  });

  it('falls back to estimated message content when usage shape is not recognized', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_3',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: '12345678',
          timestamp: 1,
          conversationId: 'conv_3',
          usage: {
            unrelated: 999
          }
        }
      ]
    });

    expect(tokens).toBe(2);
  });
});
