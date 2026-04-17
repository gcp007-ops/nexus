import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHeadlessAgentStack, HeadlessAgentStackResult } from '../eval/headless/HeadlessAgentStack';
import { TestVaultManager } from '../eval/headless/TestVaultManager';

const TEST_CONTEXT = {
  workspaceId: 'test-ws',
  sessionId: 'test-session',
  memory: 'CLI syntax regression test session.',
  goal: 'Verify ToolManager CLI discovery and execution.',
};

describe('ToolManager CLI syntax', () => {
  let stack: HeadlessAgentStackResult;
  let vaultManager: TestVaultManager;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `nexus-cli-syntax-${Date.now()}`);
    vaultManager = new TestVaultManager(testDir);
    vaultManager.reset();
    vaultManager.seed({
      'notes/source.md': '# Source\n\nInitial body.',
    });

    stack = await createHeadlessAgentStack({
      basePath: testDir,
      vaultName: 'cli-syntax-vault',
    });
  }, 30000);

  afterAll(() => {
    vaultManager.cleanup();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns CLI metadata for a specific selector', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content read',
    });

    expect(result.success).toBe(true);
    expect(result.data?.tools).toHaveLength(1);
    expect(result.data?.tools[0]).toMatchObject({
      agent: 'contentManager',
      tool: 'read',
      command: 'content read',
    });
    expect(result.data?.tools[0].usage).toContain('content read');
  });

  it('supports comma-separated multi-discovery', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content read, storage list',
    });

    expect(result.success).toBe(true);
    const identifiers = (result.data?.tools || []).map(tool => `${tool.agent}_${tool.tool}`);
    expect(identifiers).toContain('contentManager_read');
    expect(identifiers).toContain('storageManager_list');
  });

  it('writes newline-preserving content via CLI command string', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "notes/generated.md" "# Title\\n\\n- Item 1\\n- Item 2"',
    });

    expect(result.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/generated.md'), 'utf-8');
    expect(written).toBe('# Title\n\n- Item 1\n- Item 2');
  });
});
