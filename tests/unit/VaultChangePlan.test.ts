import {
  hashVaultChangePlan,
  parseVaultChangePlan,
  type ExpectedPlanIdentity,
  type VaultChangePlan
} from '../../src/services/workflows/VaultChangePlan';

const SHA256_A = `sha256:${'a'.repeat(64)}`;
const SHA256_B = `sha256:${'b'.repeat(64)}`;

function expectedIdentity(): ExpectedPlanIdentity {
  return {
    runId: 'run-1',
    workflowId: 'workflow-1',
    promptHash: SHA256_A,
    workflowHash: SHA256_B,
    workspaceId: 'workspace-1'
  };
}

function validPlan(): VaultChangePlan {
  const identity = expectedIdentity();
  return {
    schema: 'vault-change-plan/v1',
    planId: 'plan-1',
    ...identity,
    summary: 'A bounded cleanup proposal.',
    findings: [
      { findingId: 'finding-1', summary: 'Paths require normalization.', evidence: ['evidence-1'] }
    ],
    evidenceReferences: [
      { evidenceId: 'evidence-1', path: 'Notes/source.md', excerpt: 'Observed source state.', contentHash: SHA256_A }
    ],
    operations: [
      moveOperation(),
      archiveOperation(),
      setPropertyOperation(),
      replaceAnchoredOperation()
    ],
    recommendations: [
      {
        recommendationId: 'recommendation-1',
        findingId: 'finding-1',
        summary: 'Review taxonomy before creating a new category.',
        evidence: ['evidence-1']
      }
    ],
    preservationNotes: ['Keep source evidence intact.']
  };
}

function commonOperation(operationId: string) {
  return {
    operationId,
    findingId: 'finding-1',
    evidence: ['evidence-1'],
    preconditions: [{ path: 'Notes/source.md', exists: true, contentHash: SHA256_A }],
    expectedEffect: 'The requested vault change is visible.',
    risk: { level: 'low' as const, explanation: 'The operation is reversible.' },
    dependsOn: [],
    rollback: 'Restore the prior vault state from the recorded source.'
  };
}

function moveOperation() {
  return {
    ...commonOperation('move-1'),
    type: 'move' as const,
    sourcePath: 'Notes/source.md',
    destinationPath: 'Archive/source.md'
  };
}

function archiveOperation() {
  return {
    ...commonOperation('archive-1'),
    type: 'archive' as const,
    path: 'Notes/archive.md'
  };
}

function setPropertyOperation() {
  return {
    ...commonOperation('property-1'),
    type: 'setProperty' as const,
    path: 'Notes/property.md',
    property: 'status',
    value: 'archived'
  };
}

function replaceAnchoredOperation() {
  return {
    ...commonOperation('replace-1'),
    type: 'replaceAnchored' as const,
    path: 'Notes/replace.md',
    startAnchor: '## Before',
    endAnchor: '## After',
    replacement: 'Updated content.'
  };
}

function rawPlan(plan: VaultChangePlan = validPlan()): string {
  return JSON.stringify(plan);
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).reverse().map(key => [
      key,
      reverseObjectKeys((value as Record<string, unknown>)[key])
    ]));
  }
  return value;
}

function planWithOperation(type: string): string {
  const plan = validPlan() as VaultChangePlan & { operations: Array<Record<string, unknown>> };
  plan.operations = [{ ...moveOperation(), type }];
  return JSON.stringify(plan);
}

describe('VaultChangePlan', () => {
  it('accepts only the four closed operation types', () => {
    const parsed = parseVaultChangePlan(rawPlan(), expectedIdentity());

    expect(parsed.operations.map(item => item.type)).toEqual([
      'move', 'archive', 'setProperty', 'replaceAnchored'
    ]);
  });

  it.each(['contentWrite', 'taskUpdate', 'shell'])('rejects %s', type => {
    expect(() => parseVaultChangePlan(planWithOperation(type), expectedIdentity()))
      .toThrow('unsupported operation type');
  });

  it('accepts one JSON fence and rejects prose around a plan', () => {
    expect(parseVaultChangePlan(`\`\`\`json\n${rawPlan()}\n\`\`\``, expectedIdentity()).planId).toBe('plan-1');
    expect(() => parseVaultChangePlan(`Proposal:\n${rawPlan()}`, expectedIdentity()))
      .toThrow('single JSON object');
  });

  it.each([
    ['runId', 'other-run'],
    ['workflowId', 'other-workflow'],
    ['promptHash', SHA256_B],
    ['workflowHash', SHA256_A],
    ['workspaceId', 'other-workspace']
  ])('rejects a mismatched %s before hashing', (field, value) => {
    const plan = validPlan() as VaultChangePlan & Record<string, unknown>;
    plan[field] = value;

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow(`identity mismatch: ${field}`);
  });

  it.each([
    ['../../outside.md'],
    ['/absolute.md'],
    ['C:\\outside.md'],
    ['Notes/../outside.md']
  ])('rejects an out-of-vault operation path %s', path => {
    const plan = validPlan();
    plan.operations = [{ ...moveOperation(), sourcePath: path }];

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('invalid vault path');
  });

  it('rejects duplicate operation IDs, unavailable dependencies, and cycles', () => {
    const duplicate = validPlan();
    duplicate.operations = [moveOperation(), { ...archiveOperation(), operationId: 'move-1' }];
    expect(() => parseVaultChangePlan(rawPlan(duplicate), expectedIdentity()))
      .toThrow('duplicate operationId');

    const missing = validPlan();
    missing.operations = [{ ...moveOperation(), dependsOn: ['missing'] }];
    expect(() => parseVaultChangePlan(rawPlan(missing), expectedIdentity()))
      .toThrow('missing dependency');

    const cyclic = validPlan();
    cyclic.operations = [
      { ...moveOperation(), dependsOn: ['archive-1'] },
      { ...archiveOperation(), dependsOn: ['move-1'] }
    ];
    expect(() => parseVaultChangePlan(rawPlan(cyclic), expectedIdentity()))
      .toThrow('operation dependency cycle');
  });

  it('rejects malformed hash preconditions and unknown security-sensitive keys', () => {
    const malformedHash = validPlan();
    malformedHash.operations = [{
      ...moveOperation(),
      preconditions: [{ path: 'Notes/source.md', exists: true, contentHash: 'sha256:not-a-hash' }]
    }];
    expect(() => parseVaultChangePlan(rawPlan(malformedHash), expectedIdentity()))
      .toThrow('invalid sha256 hash');

    const unknownKey = validPlan() as VaultChangePlan & { operations: Array<Record<string, unknown>> };
    unknownKey.operations = [{ ...moveOperation(), tool: 'content write' }];
    expect(() => parseVaultChangePlan(rawPlan(unknownKey), expectedIdentity()))
      .toThrow('unknown key "tool"');
  });

  it('rejects raw output over 1 MiB and more than 100 operations', () => {
    expect(() => parseVaultChangePlan(`${rawPlan()}${' '.repeat(1024 * 1024)}`, expectedIdentity()))
      .toThrow('raw plan exceeds 1 MiB');

    const plan = validPlan();
    plan.operations = Array.from({ length: 101 }, (_, index) => ({
      ...moveOperation(),
      operationId: `move-${index}`
    }));
    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('plan has more than 100 operations');
  });

  it('produces the same hash for different object key order', () => {
    const reorderedPlan = reverseObjectKeys(validPlan()) as VaultChangePlan;

    expect(hashVaultChangePlan(validPlan())).toBe(hashVaultChangePlan(reorderedPlan));
  });
});
