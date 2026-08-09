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

function existingPrecondition(path: string) {
  return { path, exists: true, contentHash: SHA256_A };
}

function absentPrecondition(path: string) {
  return { path, exists: false };
}

function commonOperation(operationId: string, preconditions: unknown[]) {
  return {
    operationId,
    findingId: 'finding-1',
    evidence: ['evidence-1'],
    preconditions,
    expectedEffect: 'The requested vault change is visible.',
    risk: { level: 'low' as const, explanation: 'The operation is reversible.' },
    dependsOn: [],
    rollback: 'Restore the prior vault state from the recorded source.'
  };
}

function moveOperation() {
  return {
    ...commonOperation('move-1', [
      existingPrecondition('Notes/source.md'),
      absentPrecondition('Archive/source.md')
    ]),
    type: 'move' as const,
    sourcePath: 'Notes/source.md',
    destinationPath: 'Archive/source.md'
  };
}

function archiveOperation() {
  return {
    ...commonOperation('archive-1', [existingPrecondition('Notes/archive.md')]),
    type: 'archive' as const,
    path: 'Notes/archive.md'
  };
}

function setPropertyOperation() {
  return {
    ...commonOperation('property-1', [existingPrecondition('Notes/property.md')]),
    type: 'setProperty' as const,
    path: 'Notes/property.md',
    property: 'status',
    value: 'archived'
  };
}

function replaceAnchoredOperation() {
  return {
    ...commonOperation('replace-1', [existingPrecondition('Notes/replace.md')]),
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

  it('rejects NFKC-unstable paths and anchors without rewriting the plan', () => {
    const decomposedMove = validPlan();
    decomposedMove.operations = [{
      ...moveOperation(),
      sourcePath: 'Notes/cafe\u0301.md',
      destinationPath: 'Archive/café.md',
      preconditions: [
        existingPrecondition('Notes/cafe\u0301.md'),
        absentPrecondition('Archive/café.md')
      ]
    }];
    expect(() => parseVaultChangePlan(rawPlan(decomposedMove), expectedIdentity()))
      .toThrow('NFKC canonical');

    const unstableAnchor = validPlan();
    unstableAnchor.operations = [{
      ...replaceAnchoredOperation(),
      startAnchor: 'A\u030A section'
    }];
    expect(() => parseVaultChangePlan(rawPlan(unstableAnchor), expectedIdentity()))
      .toThrow('NFKC canonical');
  });

  it.each([
    ['DEL', 'Notes/\u007Fsource.md'],
    ['C1', 'Notes/\u0085source.md'],
    ['bidi', 'Notes/\u202Esource.md']
  ])('rejects %s control characters in paths', (_label, path) => {
    const plan = validPlan();
    plan.operations = [{
      ...archiveOperation(),
      path,
      preconditions: [existingPrecondition(path)]
    }];

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('unsafe control character');
  });

  it('rejects bidi and invisible control characters in anchors', () => {
    const plan = validPlan();
    plan.operations = [{
      ...replaceAnchoredOperation(),
      startAnchor: '## Before\u202E',
      endAnchor: '## After\u200B'
    }];

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('unsafe control character');
  });

  it('rejects U+2063 invisible separator in executable paths and anchors', () => {
    const pathPlan = validPlan();
    const unsafePath = 'Notes/\u2063source.md';
    pathPlan.operations = [{
      ...archiveOperation(),
      path: unsafePath,
      preconditions: [existingPrecondition(unsafePath)]
    }];
    expect(() => parseVaultChangePlan(rawPlan(pathPlan), expectedIdentity()))
      .toThrow('unsafe control character');

    const anchorPlan = validPlan();
    anchorPlan.operations = [{
      ...replaceAnchoredOperation(),
      startAnchor: '## Before\u2063'
    }];
    expect(() => parseVaultChangePlan(rawPlan(anchorPlan), expectedIdentity()))
      .toThrow('unsafe control character');
  });

  it.each([
    ['Cc', 'Notes/\u001Csource.md'],
    ['Cf outside the legacy list', 'Notes/\u2061source.md']
  ])('rejects categorical Unicode %s controls in paths', (_category, path) => {
    const plan = validPlan();
    plan.operations = [{
      ...archiveOperation(),
      path,
      preconditions: [existingPrecondition(path)]
    }];

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('unsafe control character');
  });

  it('accepts NFKC-stable accented text and ASCII names', () => {
    const accentedPathPlan = validPlan();
    accentedPathPlan.operations = [{
      ...archiveOperation(),
      path: 'Notes/café.md',
      preconditions: [existingPrecondition('Notes/café.md')]
    }];
    expect(parseVaultChangePlan(rawPlan(accentedPathPlan), expectedIdentity()).operations[0].type)
      .toBe('archive');

    const accentedAnchorPlan = validPlan();
    accentedAnchorPlan.operations = [{
      ...replaceAnchoredOperation(),
      startAnchor: '## Café',
      endAnchor: '## Depois'
    }];
    expect(parseVaultChangePlan(rawPlan(accentedAnchorPlan), expectedIdentity()).operations[0].type)
      .toBe('replaceAnchored');
  });

  it('requires coherent target preconditions and rejects unrelated paths', () => {
    const missingMoveDestination = validPlan();
    missingMoveDestination.operations = [{
      ...moveOperation(),
      preconditions: [existingPrecondition('Notes/source.md')]
    }];
    expect(() => parseVaultChangePlan(rawPlan(missingMoveDestination), expectedIdentity()))
      .toThrow('move destinationPath must have an absent precondition');

    const unrelated = validPlan();
    unrelated.operations = [{
      ...archiveOperation(),
      preconditions: [existingPrecondition('Notes/unrelated.md')]
    }];
    expect(() => parseVaultChangePlan(rawPlan(unrelated), expectedIdentity()))
      .toThrow('archive path must have an existing precondition');
  });

  it.each(['__proto__', 'prototype', 'constructor'])('rejects unsafe setProperty key %s', property => {
    const plan = validPlan();
    plan.operations = [{ ...setPropertyOperation(), property }];

    expect(() => parseVaultChangePlan(rawPlan(plan), expectedIdentity()))
      .toThrow('unsafe setProperty property');
  });

  it('rejects unsafe keys nested inside a setProperty JSON value', () => {
    const poisonedValue = rawPlan({
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: { safe: true } }]
    }).replace('"value":{"safe":true}', '"value":{"__proto__":{"polluted":true}}');

    expect(() => parseVaultChangePlan(poisonedValue, expectedIdentity()))
      .toThrow('unsafe setProperty value key');
  });

  it('rejects duplicate JSON keys before JSON.parse can overwrite them', () => {
    const topLevelDuplicate = rawPlan().replace(
      '"planId":"plan-1"',
      '"planId":"forged","planId":"plan-1"'
    );
    expect(() => parseVaultChangePlan(topLevelDuplicate, expectedIdentity()))
      .toThrow('duplicate JSON key "planId"');

    const targetDuplicate = rawPlan(validPlan()).replace(
      '"sourcePath":"Notes/source.md"',
      '"sourcePath":"Notes/forged.md","sourcePath":"Notes/source.md"'
    );
    expect(() => parseVaultChangePlan(targetDuplicate, expectedIdentity()))
      .toThrow('duplicate JSON key "sourcePath"');

    const valueDuplicate = rawPlan({
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: { safe: 1 } }]
    }).replace('"value":{"safe":1}', '"value":{"safe":1,"safe":2}');
    expect(() => parseVaultChangePlan(valueDuplicate, expectedIdentity()))
      .toThrow('duplicate JSON key "safe"');
  });

  it('rejects non-JSON direct hash values that could collide with empty objects', () => {
    const withDate = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: new Date(0) }]
    } as unknown as VaultChangePlan;
    const withEmptyObject = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: {} }]
    } as VaultChangePlan;

    expect(() => hashVaultChangePlan(withDate)).toThrow('plain object');
    expect(hashVaultChangePlan(withEmptyObject)).toMatch(/^sha256:/);
  });

  it.each([
    ['class instance', new (class Value {})()],
    ['Array subclass', new (class Value extends Array<unknown> {})()],
    ['Map', new Map([['key', 'value']])],
    ['Set', new Set(['value'])],
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['bigint', BigInt(1)],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])('rejects %s from public canonical hashing', (_label, value) => {
    const plan = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value }]
    } as unknown as VaultChangePlan;

    expect(() => hashVaultChangePlan(plan)).toThrow();
  });

  it('rejects sparse arrays and cycles while preserving deterministic plain objects', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'value';
    const sparsePlan = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: sparse }]
    } as unknown as VaultChangePlan;
    expect(() => hashVaultChangePlan(sparsePlan)).toThrow('sparse array');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicPlan = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: cyclic }]
    } as unknown as VaultChangePlan;
    expect(() => hashVaultChangePlan(cyclicPlan)).toThrow('cycle');

    const nullPrototypeValue = Object.assign(Object.create(null), { nested: ['value'] });
    const plainPlan = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: { nested: ['value'] } }]
    } as VaultChangePlan;
    const nullPrototypePlan = {
      ...validPlan(),
      operations: [{ ...setPropertyOperation(), value: nullPrototypeValue }]
    } as unknown as VaultChangePlan;
    expect(hashVaultChangePlan(nullPrototypePlan)).toBe(hashVaultChangePlan(plainPlan));
  });
});
