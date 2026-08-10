import { SessionContextManager } from '../../src/services/SessionContextManager';

describe('SessionContextManager', () => {
  it('keeps a friendly session handle model-facing while storing an internal ID', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('workspace setup', 'Testing session handles', 'default');

    expect(result.id).toMatch(/^s-/);
    expect(result.displaySessionId).toBe('workspace setup');
    expect(result.displaySessionIdChanged).toBe(false);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        name: 'workspace setup',
        description: 'Testing session handles',
        workspaceId: 'default'
      })
    );

    await expect(manager.validateSessionId('workspace setup', undefined, 'default')).resolves.toEqual(
      expect.objectContaining({
        id: result.id,
        created: false,
        displaySessionId: 'workspace setup',
        displaySessionIdChanged: false
      })
    );
  });

  it('suffixes duplicate friendly session handles and reports the display handle', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([
        { id: 's-existing', workspaceId: 'default', name: 'session' }
      ]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('session', undefined, 'default');

    expect(result.displaySessionId).toBe('session-2');
    expect(result.displaySessionIdChanged).toBe(true);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'session-2'
      })
    );

    await expect(manager.validateSessionId('session-2', undefined, 'default')).resolves.toEqual(
      expect.objectContaining({
        id: result.id,
        created: false,
        displaySessionId: 'session-2'
      })
    );
  });

  it('exposes the explicit workspace as the effective session workspace', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('planning', undefined, 'ws-engineering');

    expect(result.effectiveWorkspaceId).toBe('ws-engineering');
  });

  it('reuses a uniquely bound friendly handle when workspaceId is omitted', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const first = await manager.validateSessionId('planning', undefined, 'ws-engineering');
    const inherited = await manager.validateSessionId('planning');

    expect(inherited.id).toBe(first.id);
    expect(inherited.created).toBe(false);
    expect(inherited.effectiveWorkspaceId).toBe('ws-engineering');
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
  });

  it('treats a blank workspaceId as omitted and inherits a unique handle binding', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    const first = await manager.validateSessionId('planning', undefined, 'ws-engineering');
    const inherited = await manager.validateSessionId('planning', undefined, '   ');

    expect(inherited.id).toBe(first.id);
    expect(inherited.effectiveWorkspaceId).toBe('ws-engineering');
  });

  it('rejects an omitted workspaceId when the friendly handle exists in multiple workspaces', async () => {
    const manager = new SessionContextManager();
    const sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      getAllSessions: jest.fn().mockResolvedValue([]),
      createSession: jest.fn(),
      updateSession: jest.fn()
    };
    manager.setSessionService(sessionService);

    await manager.validateSessionId('planning', undefined, 'ws-engineering');
    await manager.validateSessionId('planning', undefined, 'ws-research');

    await expect(manager.validateSessionId('planning')).rejects.toThrow(/ambiguous.*workspace/i);
    expect(sessionService.createSession).toHaveBeenCalledTimes(2);
  });

  describe('active skills (§9 usage attribution)', () => {
    it('returns an empty array for a session with no active skills', () => {
      const manager = new SessionContextManager();
      expect(manager.getActiveSkills('s-1')).toEqual([]);
    });

    it('adds and dedupes active skills', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.addActiveSkill('s-1', 'codex/pr-reviewer');
      manager.addActiveSkill('s-1', 'claude/essay-editor'); // duplicate — ignored

      expect(manager.getActiveSkills('s-1')).toEqual(['claude/essay-editor', 'codex/pr-reviewer']);
    });

    it('keeps active skills per-session isolated', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.addActiveSkill('s-2', 'codex/pr-reviewer');

      expect(manager.getActiveSkills('s-1')).toEqual(['claude/essay-editor']);
      expect(manager.getActiveSkills('s-2')).toEqual(['codex/pr-reviewer']);
    });

    it('setActiveSkills replaces the set', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.setActiveSkills('s-1', ['codex/pr-reviewer']);

      expect(manager.getActiveSkills('s-1')).toEqual(['codex/pr-reviewer']);
    });

    it('is NOT clobbered by a subsequent setWorkspaceContext (dedicated map)', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      // This is the frequent ToolCallTraceService:88 call — must not wipe skills.
      manager.setWorkspaceContext('s-1', { workspaceId: 'ws-blog' });

      expect(manager.getActiveSkills('s-1')).toEqual(['claude/essay-editor']);
    });

    it('clears active skills on clearWorkspaceContext', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.clearWorkspaceContext('s-1');

      expect(manager.getActiveSkills('s-1')).toEqual([]);
    });

    it('clears active skills on session eviction', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.evictSessionHandles('s-1', 'default');

      expect(manager.getActiveSkills('s-1')).toEqual([]);
    });

    it('clears active skills on clearAll', () => {
      const manager = new SessionContextManager();
      manager.addActiveSkill('s-1', 'claude/essay-editor');
      manager.clearAll();

      expect(manager.getActiveSkills('s-1')).toEqual([]);
    });
  });
});
