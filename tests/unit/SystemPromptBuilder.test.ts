import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';

describe('SystemPromptBuilder compaction projection', () => {
  it('renders a deterministic bounded frontier block', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      compactionFrontier: [
        {
          summary: 'Refined the task flow and fixed parser edge cases.',
          messagesRemoved: 12,
          messagesKept: 4,
          filesReferenced: [
            'A.md',
            'B.md',
            'C.md',
            'D.md',
            'E.md',
            'F.md'
          ],
          topics: [
            'transport hardening',
            'token usage normalization',
            'compaction rollout',
            'state persistence',
            'search memory',
            'prompt caching',
            'headless smoke test',
            'Gemini model validation',
            'future meta-compaction'
          ],
          compactedAt: 1_742_900_000_000,
          transcriptCoverage: {
            conversationId: 'conv_1',
            startSequenceNumber: 0,
            endSequenceNumber: 11
          }
        },
        {
          summary: 'Then validated the CLI transport fixes.',
          messagesRemoved: 6,
          messagesKept: 4,
          filesReferenced: ['Transport.md'],
          topics: ['cli transport', 'smoke tests'],
          compactedAt: 1_742_900_000_100,
          level: 1,
          mergedRecordCount: 2,
          transcriptCoverageAncestry: [
            {
              conversationId: 'conv_1',
              startSequenceNumber: 12,
              endSequenceNumber: 17
            },
            {
              conversationId: 'conv_1',
              startSequenceNumber: 18,
              endSequenceNumber: 25
            }
          ],
          transcriptCoverage: {
            conversationId: 'conv_1',
            startSequenceNumber: 12,
            endSequenceNumber: 17
          }
        }
      ]
    });

    expect(prompt).toContain('<compaction_context>');
    expect(prompt).toContain('<status>active</status>');
    expect(prompt).toContain('<source>bounded_frontier</source>');
    expect(prompt).toContain('<frontier_records count="2">');
    expect(prompt).toContain('<record index="0" compacted_at="1742900000000" level="0" merged_records="1">');
    expect(prompt).toContain('<summary>Refined the task flow and fixed parser edge cases.</summary>');
    expect(prompt).toContain('<files>A.md, B.md, C.md, D.md, E.md (+1 more)</files>');
    expect(prompt).toContain('<topics>transport hardening; token usage normalization; compaction rollout; state persistence; search memory; prompt caching; headless smoke test; Gemini model validation (+1 more)</topics>');
    expect(prompt).toContain('<coverage conversation_id="conv_1" start_sequence_number="0" end_sequence_number="11" />');
    expect(prompt).toContain('<stats messages_compacted="12" messages_retained="4" />');
    expect(prompt).toContain('<record index="1" compacted_at="1742900000100" level="1" merged_records="2">');
    expect(prompt).toContain('<summary>Then validated the CLI transport fixes.</summary>');
    expect(prompt).toContain('<coverage_ancestry count="2">conv_1:12-17 | conv_1:18-25</coverage_ancestry>');
    expect(prompt).toContain('<instruction>Treat this block as compressed prior conversation context.');
    expect(prompt).not.toContain('<previous_context>');
  });

  it('falls back to rendering a legacy single compaction record when no frontier is provided', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      legacyCompactionRecord: {
        summary: 'Earlier work summary.',
        messagesRemoved: 2,
        messagesKept: 2,
        filesReferenced: [],
        topics: [],
        compactedAt: 123
      }
    });

    expect(prompt).toContain('<source>bounded_frontier</source>');
    expect(prompt).toContain('<frontier_records count="1">');
    expect(prompt).toContain('<record index="0" compacted_at="123" level="0" merged_records="1">');
  });

  it('keeps the legacy previousContext option working as a compatibility alias', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      previousContext: {
        summary: 'Legacy alias summary.',
        messagesRemoved: 1,
        messagesKept: 1,
        filesReferenced: [],
        topics: [],
        compactedAt: 456
      }
    });

    expect(prompt).toContain('<frontier_records count="1">');
    expect(prompt).toContain('<record index="0" compacted_at="456" level="0" merged_records="1">');
  });

  it('places the compaction block before the tools/context section', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      compactionFrontier: [{
        summary: 'Earlier work summary.',
        messagesRemoved: 2,
        messagesKept: 2,
        filesReferenced: [],
        topics: [],
        compactedAt: 123
      }]
    });

    expect(prompt).not.toBeNull();
    const compactionIndex = prompt!.indexOf('<compaction_context>');
    const toolsIndex = prompt!.indexOf('<tools_and_context>');

    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(toolsIndex).toBeGreaterThan(compactionIndex);
  });
});
