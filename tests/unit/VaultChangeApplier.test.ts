import { parseYaml, stringifyYaml, TFile, TFolder } from 'obsidian';
import {
  VaultChangeApplier,
  type ApprovalRequest,
  type VaultChangeApplyReceipt
} from '../../src/services/workflows/VaultChangeApplier';
import { VaultChangePreconditions } from '../../src/services/workflows/VaultChangePreconditions';
import { VaultOperations } from '../../src/core/VaultOperations';
import {
  hashVaultChangePlan,
  type VaultChangeOperation,
  type VaultChangePlan
} from '../../src/services/workflows/VaultChangePlan';

const PROMPT_HASH = `sha256:${'a'.repeat(64)}`;
const WORKFLOW_HASH = `sha256:${'b'.repeat(64)}`;

interface MemoryFile {
  file: TFile;
  content: string;
}

class MemoryVault {
  readonly files = new Map<string, MemoryFile>();
  readonly folders = new Map<string, TFolder>();
  readonly read = jest.fn(async (file: TFile) => {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing file: ${file.path}`);
    return entry.content;
  });
  readonly process = jest.fn(async (file: TFile, transform: (content: string) => string) => {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing file: ${file.path}`);
    entry.content = transform(entry.content);
  });
  readonly createFolder = jest.fn(async (path: string) => {
    this.folders.set(path, new TFolder(path));
  });
  readonly adapter = {
    exists: jest.fn(async (path: string) => this.files.has(path) || this.folders.has(path)),
    mkdir: jest.fn(async (path: string) => {
      this.folders.set(path, new TFolder(path));
    })
  };

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      const name = path.split('/').pop() ?? path;
      this.files.set(path, { file: new TFile(name, path), content });
    }
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    return this.folders.get(path) ?? null;
  }
}

function createHarness(initial: Record<string, string> = {}) {
  const vault = new MemoryVault(initial);
  const fileManager = {
    renameFile: jest.fn(async (item: TFile | TFolder, destinationPath: string) => {
      if (item instanceof TFile) {
        const entry = vault.files.get(item.path);
        if (!entry) throw new Error(`missing source: ${item.path}`);
        vault.files.delete(item.path);
        item.path = destinationPath;
        item.name = destinationPath.split('/').pop() ?? destinationPath;
        vault.files.set(destinationPath, entry);
        return;
      }
      vault.folders.delete(item.path);
      item.path = destinationPath;
      vault.folders.set(destinationPath, item);
    }),
    processFrontMatter: jest.fn(async (
      file: TFile,
      mutate: (frontmatter: Record<string, unknown>) => void
    ) => {
      const entry = vault.files.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(entry.content);
      const frontmatter = match
        ? parseYaml(match[1]) as Record<string, unknown>
        : {};
      mutate(frontmatter);
      const body = match ? entry.content.slice(match[0].length) : entry.content;
      entry.content = `---\n${stringifyYaml(frontmatter)}---\n${body}`;
    })
  };
  const app = { vault, fileManager };
  const preconditions = new VaultChangePreconditions(vault as never);
  const pathManager = {
    normalizePath: (path: string) => path,
    getParentPath: (path: string) => path.split('/').slice(0, -1).join('/'),
    ensureParentExists: jest.fn().mockResolvedValue(undefined)
  };
  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  };
  const vaultOperations = new VaultOperations(
    app as never,
    vault as never,
    pathManager as never,
    logger as never
  );
  const applier = new VaultChangeApplier({
    app: app as never,
    preconditions,
    vaultOperations,
    now: () => 1_700_000_000_000
  } as never);
  return { applier, vault, fileManager, vaultOperations };
}

function operation(
  type: VaultChangeOperation['type'],
  overrides: Record<string, unknown> = {}
): VaultChangeOperation {
  const common = {
    operationId: 'op-1',
    findingId: 'finding-1',
    evidence: ['evidence-1'],
    expectedEffect: 'Apply the approved change.',
    risk: { level: 'low' as const, explanation: 'Fixture.' },
    dependsOn: [] as string[],
    rollback: 'Restore the captured source state.'
  };
  switch (type) {
    case 'move':
      return {
        ...common,
        type,
        sourcePath: 'from.md',
        destinationPath: 'Moved/to.md',
        preconditions: [
          { path: 'from.md', exists: true },
          { path: 'Moved/to.md', exists: false }
        ],
        ...overrides
      } as VaultChangeOperation;
    case 'archive':
      return {
        ...common,
        type,
        path: 'archive.md',
        preconditions: [{ path: 'archive.md', exists: true }],
        ...overrides
      } as VaultChangeOperation;
    case 'setProperty':
      return {
        ...common,
        type,
        path: 'property.md',
        property: 'status',
        value: 'done',
        preconditions: [{ path: 'property.md', exists: true }],
        ...overrides
      } as VaultChangeOperation;
    case 'replaceAnchored':
      return {
        ...common,
        type,
        path: 'replace.md',
        startAnchor: 'START',
        endAnchor: 'END',
        replacement: 'replacement',
        preconditions: [{ path: 'replace.md', exists: true }],
        ...overrides
      } as VaultChangeOperation;
  }
}

function plan(operations: VaultChangeOperation[]): VaultChangePlan {
  return {
    schema: 'vault-change-plan/v1',
    planId: 'plan-1',
    runId: 'run-1',
    workflowId: 'workflow-1',
    promptHash: PROMPT_HASH,
    workflowHash: WORKFLOW_HASH,
    workspaceId: 'workspace-1',
    summary: 'Apply selected fixture operations.',
    findings: [{ findingId: 'finding-1', summary: 'Fixture finding.', evidence: ['evidence-1'] }],
    evidenceReferences: [{ evidenceId: 'evidence-1', path: 'evidence.md', excerpt: 'Fixture.' }],
    operations,
    recommendations: [],
    preservationNotes: []
  };
}

function approvalFor(value: VaultChangePlan, ...operationIds: string[]): ApprovalRequest {
  return {
    runId: value.runId,
    planHash: hashVaultChangePlan(value),
    operationIds,
    approval: { kind: 'human', source: 'nexus-ui', confirmedAt: 1_700_000_000_000 }
  };
}

describe('VaultChangeApplier', () => {
  it('routes approved mutations through the confined vault facade', async () => {
    const { applier, vaultOperations } = createHarness({ 'from.md': 'body' });
    const movePath = jest.spyOn(vaultOperations, 'movePath');
    const value = plan([operation('move')]);

    await applier.apply(value, approvalFor(value, 'op-1'));

    expect(movePath).toHaveBeenCalledWith('from.md', 'Moved/to.md');
  });

  it.each(['move', 'archive', 'setProperty', 'replaceAnchored'] as const)(
    'applies and reads back a selected %s operation', async type => {
      const { applier } = createHarness({
        'from.md': 'move',
        'archive.md': 'archive',
        'property.md': '---\nstatus: todo\n---\nBody\n',
        'replace.md': 'Before\nSTART\nold\nEND\nAfter'
      });
      const value = plan([operation(type)]);

      const result = await applier.apply(value, approvalFor(value, 'op-1'));

      expect(result.operations).toEqual([
        expect.objectContaining({ operationId: 'op-1', type, status: 'succeeded' })
      ]);
      expect(result.operations[0].readback).toEqual(expect.any(Object));
    }
  );

  it('continues an independent operation and blocks a dependent after failure', async () => {
    const { applier } = createHarness({
      'dependent.md': 'START\nold\nEND',
      'independent.md': 'START\nold\nEND'
    });
    const operations = [
      operation('replaceAnchored', { operationId: 'op-1', path: 'missing.md', preconditions: [{ path: 'missing.md', exists: true }] }),
      operation('replaceAnchored', { operationId: 'op-2', path: 'dependent.md', dependsOn: ['op-1'], preconditions: [{ path: 'dependent.md', exists: true }] }),
      operation('replaceAnchored', { operationId: 'op-3', path: 'independent.md', preconditions: [{ path: 'independent.md', exists: true }] })
    ];
    const value = plan(operations);

    const result = await applier.apply(value, approvalFor(value, 'op-1', 'op-2', 'op-3'));

    expect(Object.fromEntries(result.operations.map(item => [item.operationId, item.status]))).toEqual({
      'op-1': 'failed',
      'op-2': 'blocked_dependency',
      'op-3': 'succeeded'
    });
  });

  it('rolls back an applied effect when authoritative readback fails', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    vault.read
      .mockImplementationOnce(async (file: TFile) => vault.files.get(file.path)?.content ?? '')
      .mockImplementationOnce(async () => 'tampered after write');
    const value = plan([operation('replaceAnchored')]);

    const result = await applier.apply(value, approvalFor(value, 'op-1'));

    expect(result.operations[0].status).toBe('rolled_back');
    expect(vault.process).toHaveBeenCalledTimes(2);
    expect(vault.files.get('replace.md')?.content).toBe('Before\nSTART\nold\nEND\nAfter');
  });

  it('reports rollback_failed without retrying the effect', async () => {
    const { applier, vault, fileManager } = createHarness({
      'property.md': '---\nstatus: todo\n---\nBody\n'
    });
    vault.read
      .mockImplementationOnce(async (file: TFile) => vault.files.get(file.path)?.content ?? '')
      .mockImplementationOnce(async (file: TFile) => vault.files.get(file.path)?.content ?? '')
      .mockImplementationOnce(async () => '---\nstatus: wrong\n---\nBody\n');
    vault.process.mockRejectedValueOnce(new Error('rollback disk failure'));
    const value = plan([operation('setProperty')]);

    const result = await applier.apply(value, approvalFor(value, 'op-1'));

    expect(result.operations[0]).toMatchObject({
      status: 'rollback_failed',
      rollbackError: 'rollback disk failure'
    });
    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    expect(vault.process).toHaveBeenCalledTimes(1);
  });

  it('reports rollback_failed when rollback returns without restoring exact bytes', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    vault.read
      .mockImplementationOnce(async (file: TFile) => vault.files.get(file.path)?.content ?? '')
      .mockImplementationOnce(async () => 'tampered after write')
      .mockImplementationOnce(async () => 'still not restored');
    vault.process.mockImplementationOnce(async (file: TFile, transform: (content: string) => string) => {
      const entry = vault.files.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      entry.content = transform(entry.content);
    }).mockResolvedValueOnce(undefined);
    const value = plan([operation('replaceAnchored')]);

    const result = await applier.apply(value, approvalFor(value, 'op-1'));

    expect(result.operations[0]).toMatchObject({
      status: 'rollback_failed',
      rollbackError: 'authoritative rollback readback failed'
    });
    expect(vault.process).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate selected IDs and incomplete dependency selections before approval or effects', async () => {
    const { applier, fileManager } = createHarness({
      'first.md': 'START\nold\nEND',
      'second.md': 'START\nold\nEND'
    });
    const value = plan([
      operation('replaceAnchored', { operationId: 'op-0', path: 'first.md', preconditions: [{ path: 'first.md', exists: true }] }),
      operation('replaceAnchored', { operationId: 'op-1', path: 'second.md', dependsOn: ['op-0'], preconditions: [{ path: 'second.md', exists: true }] })
    ]);
    const beforeEffects = jest.fn(async () => undefined);

    await expect(applier.apply(value, approvalFor(value, 'op-1', 'op-1'), beforeEffects))
      .rejects.toThrow('duplicate selected operationId');
    await expect(applier.apply(value, approvalFor(value, 'op-1'), beforeEffects))
      .rejects.toThrow('selected operation op-1 requires selected dependency op-0');
    expect(beforeEffects).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('checks the current file hash immediately before apply and performs no stale effect', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'START\nstale\nEND'
    });
    const freshHash = `sha256:${'0'.repeat(64)}`;
    const value = plan([operation('replaceAnchored', {
      preconditions: [{ path: 'replace.md', exists: true, contentHash: freshHash }]
    })]);

    const result = await applier.apply(value, approvalFor(value, 'op-1'));

    expect(result.operations[0]).toMatchObject({ status: 'failed' });
    expect(result.operations[0].error).toContain('content hash mismatch');
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('persists approval through the supplied gate before the first effect', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'START\nold\nEND'
    });
    const value = plan([operation('replaceAnchored')]);
    const beforeEffects = jest.fn(async () => undefined);

    await applier.apply(value, approvalFor(value, 'op-1'), beforeEffects);

    expect(beforeEffects.mock.invocationCallOrder[0])
      .toBeLessThan(vault.process.mock.invocationCallOrder[0]);
  });

  it('performs no effect when the approval gate rejects', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'START\nold\nEND'
    });
    const value = plan([operation('replaceAnchored')]);

    await expect(applier.apply(
      value,
      approvalFor(value, 'op-1'),
      async () => { throw new Error('approval persistence failed'); }
    )).rejects.toThrow('approval persistence failed');

    expect(vault.process).not.toHaveBeenCalled();
  });

  it('reconciles a durable receipt by authoritative readback without another effect or rollback', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    const value = plan([operation('replaceAnchored')]);
    const applied = await applier.apply(value, approvalFor(value, 'op-1'));
    const receipt: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v1',
      runId: value.runId,
      planHash: applied.planHash,
      operationIds: ['op-1'],
      operations: applied.operations
    };
    const effectCalls = vault.process.mock.calls.length;

    await expect(applier.reconcile(value, receipt)).resolves.toEqual(applied);
    expect(vault.process).toHaveBeenCalledTimes(effectCalls);

    const entry = vault.files.get('replace.md');
    if (!entry) throw new Error('Expected replace.md');
    entry.content = 'changed after receipt';
    await expect(applier.reconcile(value, receipt))
      .rejects.toThrow('authoritative receipt readback failed');
    expect(vault.process).toHaveBeenCalledTimes(effectCalls);
  });

  it('recovers a durable pending effect by authoritative readback when the effect rejects after mutation', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    const value = plan([operation('replaceAnchored')]);
    let receipt: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: [{
        operationId: 'op-1',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'selected'
      }]
    };
    const beforeOperation = jest.fn(async writeAhead => {
      expect(vault.process).not.toHaveBeenCalled();
      receipt = {
        ...receipt,
        schema: 'agent-run-apply-receipt/v2',
        operations: [{ ...writeAhead, selectedAt: 900, state: 'pending' }]
      };
    });
    vault.process.mockImplementationOnce(async (
      file: TFile,
      transform: (content: string) => string
    ) => {
      const entry = vault.files.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      entry.content = transform(entry.content);
      throw new Error('effect promise rejected after mutation');
    });

    await expect(applier.apply(
      value,
      approvalFor(value, 'op-1'),
      async () => undefined,
      async () => undefined,
      beforeOperation
    )).rejects.toThrow('outcome is unknown after durable write-ahead');

    expect(beforeOperation).toHaveBeenCalledTimes(1);
    const effectCalls = vault.process.mock.calls.length;
    await expect(applier.reconcile(value, receipt)).resolves.toMatchObject({
      status: 'completed',
      operations: [expect.objectContaining({ operationId: 'op-1', status: 'succeeded' })]
    });
    expect(vault.process).toHaveBeenCalledTimes(effectCalls);
  });

  it('never runs later effects during recovery and blocks dependents of an unresolved predecessor', async () => {
    const { applier, vault, fileManager } = createHarness({
      'first.md': 'START\nold\nEND',
      'second.md': 'START\nold\nEND',
      'third.md': 'START\nold\nEND'
    });
    const value = plan([
      operation('replaceAnchored', {
        operationId: 'op-0', path: 'first.md', preconditions: [{ path: 'first.md', exists: true }]
      }),
      operation('replaceAnchored', {
        operationId: 'op-1', path: 'second.md', dependsOn: ['op-0'],
        preconditions: [{ path: 'second.md', exists: true }]
      }),
      operation('replaceAnchored', {
        operationId: 'op-2', path: 'third.md', preconditions: [{ path: 'third.md', exists: true }]
      })
    ]);
    const receipt: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-0', 'op-1', 'op-2'],
      operations: [{
        operationId: 'op-0',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'pending',
        startedAt: 901,
        expectedReadback: {
          kind: 'contentHash', path: 'first.md', contentHash: `sha256:${'f'.repeat(64)}`
        }
      }, {
        operationId: 'op-1',
        type: 'replaceAnchored',
        dependsOn: ['op-0'],
        selectedAt: 900,
        state: 'selected'
      }, {
        operationId: 'op-2',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'selected'
      }]
    };

    await expect(applier.reconcile(value, receipt)).resolves.toMatchObject({
      status: 'completed_with_issues',
      operations: [
        expect.objectContaining({ operationId: 'op-0', status: 'readback_failed' }),
        expect.objectContaining({ operationId: 'op-1', status: 'blocked_dependency' }),
        expect.objectContaining({ operationId: 'op-2', status: 'failed' })
      ]
    });
    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('persists an unresolved recovery result when authoritative readback itself is unavailable', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'START\nold\nEND'
    });
    const value = plan([operation('replaceAnchored')]);
    const receipt: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: [{
        operationId: 'op-1',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'pending',
        startedAt: 901,
        expectedReadback: {
          kind: 'contentHash', path: 'replace.md', contentHash: `sha256:${'f'.repeat(64)}`
        }
      }]
    };
    vault.files.delete('replace.md');

    await expect(applier.reconcile(value, receipt)).resolves.toMatchObject({
      status: 'completed_with_issues',
      operations: [expect.objectContaining({
        operationId: 'op-1',
        status: 'readback_failed',
        error: expect.stringContaining('unavailable')
      })]
    });
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('retries only readback for a settled snapshotless recovery result until state is available', async () => {
    const { applier, vault, fileManager } = createHarness({
      'property.md': '---\nstatus: todo\n---\nBody\n'
    });
    const value = plan([operation('setProperty')]);
    const pendingReceipt: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: [{
        operationId: 'op-1',
        type: 'setProperty',
        dependsOn: [],
        selectedAt: 900,
        state: 'pending',
        startedAt: 901,
        expectedReadback: {
          kind: 'setProperty', path: 'property.md', property: 'status', value: 'done'
        }
      }]
    };
    vault.files.delete('property.md');

    const unavailable = await applier.reconcile(value, pendingReceipt);
    const settledReceipt: VaultChangeApplyReceipt = {
      ...pendingReceipt,
      schema: 'agent-run-apply-receipt/v2',
      operations: [{
        operationId: 'op-1',
        type: 'setProperty',
        dependsOn: [],
        selectedAt: 900,
        state: 'settled',
        startedAt: 901,
        expectedReadback: {
          kind: 'setProperty', path: 'property.md', property: 'status', value: 'done'
        },
        result: unavailable.operations[0]
      }]
    };

    await expect(applier.reconcile(value, settledReceipt)).resolves.toEqual(unavailable);
    vault.files.set('property.md', {
      file: new TFile('property.md', 'property.md'),
      content: '---\nstatus: done\n---\nBody\n'
    });
    await expect(applier.reconcile(value, settledReceipt)).resolves.toMatchObject({
      status: 'completed',
      operations: [expect.objectContaining({
        operationId: 'op-1',
        status: 'succeeded',
        readback: expect.objectContaining({ value: 'done' })
      })]
    });

    expect(vault.process).not.toHaveBeenCalled();
    expect(fileManager.renameFile).not.toHaveBeenCalled();
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('fails closed for a snapshotless readback_failed result without the recovery-unavailable marker', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    const value = plan([operation('replaceAnchored')]);
    const malformed: VaultChangeApplyReceipt = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: [{
        operationId: 'op-1',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'settled',
        startedAt: 901,
        expectedReadback: {
          kind: 'contentHash', path: 'replace.md', contentHash: `sha256:${'f'.repeat(64)}`
        },
        result: {
          operationId: 'op-1',
          type: 'replaceAnchored',
          status: 'readback_failed',
          startedAt: 901,
          finishedAt: 901
        }
      }]
    };

    await expect(applier.reconcile(value, malformed))
      .rejects.toThrow('lacks authoritative readback');
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('fails closed for old incomplete and non-closed durable receipts', async () => {
    const { applier, vault } = createHarness({
      'replace.md': 'Before\nSTART\nold\nEND\nAfter'
    });
    const value = plan([operation('replaceAnchored')]);
    const incomplete = {
      schema: 'agent-run-apply-receipt/v1',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: []
    } as VaultChangeApplyReceipt;
    const nonClosed = {
      schema: 'agent-run-apply-receipt/v2',
      runId: value.runId,
      planHash: hashVaultChangePlan(value),
      operationIds: ['op-1'],
      operations: [{
        operationId: 'op-1',
        type: 'replaceAnchored',
        dependsOn: [],
        selectedAt: 900,
        state: 'selected',
        capabilityToken: 'must-not-persist'
      }]
    } as unknown as VaultChangeApplyReceipt;

    await expect(applier.reconcile(value, incomplete))
      .rejects.toThrow('incomplete or out of order');
    await expect(applier.reconcile(value, nonClosed))
      .rejects.toThrow('unknown field');
    expect(vault.process).not.toHaveBeenCalled();
  });

  it.each(['.hidden/note.md', '_Base/Dados/note.md', '_Base/PluginsSync/note.md'])(
    'rejects protected model path %s before approval', async path => {
      const { applier, vault } = createHarness({ [path]: 'START\nold\nEND' });
      const value = plan([operation('replaceAnchored', {
        path,
        preconditions: [{ path, exists: true }]
      })]);
      const beforeEffects = jest.fn(async () => undefined);

      await expect(applier.apply(value, approvalFor(value, 'op-1'), beforeEffects))
        .rejects.toThrow('protected vault path');
      expect(beforeEffects).not.toHaveBeenCalled();
      expect(vault.process).not.toHaveBeenCalled();
    }
  );
});
