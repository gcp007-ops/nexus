import { normalizeCommand, normalizeQuery } from '../../src/agents/taskManager/authority/TaskAuthorityContracts';
const hash = 'a'.repeat(64);
const envelope = { protocol: 'task-authority-command/v1', vault_scope: 'v', authority_id: 'a', project_id: 'p', issuer_id: 'i', operation_id: 'o', expected_revision: 0 };
describe('task authority closed contracts', () => {
  it('accepts the command variants with all required fields', () => {
    const capability_ref = { id: 'c', version: 1, revision: 1, hash };
    const resources = ['project:p', 'task:t'];
    const commands = [
      { type: 'admitProject', baseline_hash: hash },
      { type: 'acquireUnit', task_id: 't', resources, lease_ms: 5, capability_ref },
      { type: 'renewLease', lease_id: 'l', epoch: 0, lease_ms: 5 },
      { type: 'releaseLease', lease_id: 'l', epoch: 0 },
      { type: 'dispatchEffect', lease_id: 'l', epoch: 0, effect_id: 'e', capability_ref, resources, precondition_hash: hash, proposal_ref: { artifact_id: 'r', hash }, proposal_hash: hash },
      { type: 'beginEffect', dispatch_id: 'd', effect_id: 'e', lease_id: 'l', epoch: 0, host_id: 'h', proposal_hash: hash },
      { type: 'recordEffect', dispatch_id: 'd', effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, receipt_hash: hash, result: 'applied' },
      { type: 'commitProgress', lease_id: 'l', epoch: 0, effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, task_id: 't', expected_status: 'todo', next_status: 'in_progress', evidence_refs: [{ artifact_id: 'e', hash }] },
      { type: 'interactiveMutation', resources, mutation: { kind: 'moveTask', arguments: { taskId: 't', parentTaskId: null } } },
    ];
    for (const command of commands) expect(normalizeCommand({ ...envelope, command })).toBeDefined();
  });
  it('rejects extra keys, invalid hashes, invalid resources and forged metadata', () => {
    for (const command of [
      { type: 'admitProject', baseline_hash: hash, unexpected: true },
      { type: 'admitProject', baseline_hash: 'short' },
      { type: 'acquireUnit', task_id: 't', resources: ['task:t', 'project:p'], lease_ms: 5, capability_ref: { id: 'c', version: 1, revision: 1, hash } },
      { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', metadata: { dream_priority_v1: {} } } } },
      { type: 'commitProgress', lease_id: 'l', epoch: 0, effect_id: 'e', receipt_ref: { artifact_id: 'r', hash }, task_id: 't', expected_status: 'todo', next_status: 'done', evidence_refs: [{ artifact_id: 'e', hash }] },
    ]) expect(() => normalizeCommand({ ...envelope, command })).toThrow();
    expect(() => normalizeCommand({ ...envelope, extra: 1, command: { type: 'admitProject', baseline_hash: hash } })).toThrow();
  });
  it('rejects attempts to remove reserved derived metadata', () => {
    const command = { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', removeMetadataKeys: ['dream_priority_v1'] } } };
    expect(() => normalizeCommand({ ...envelope, command })).toThrow();
  });
  it('rejects noncanonical file resources', () => {
    const capability_ref = { id: 'c', version: 1, revision: 1, hash };
    for (const resource of ['file:v:../escape', 'file:v:/absolute', 'file:v:a/../b', 'file:v:a//b']) {
      expect(() => normalizeCommand({ ...envelope, command: { type: 'acquireUnit', task_id: 't', resources: [resource], lease_ms: 5, capability_ref } })).toThrow();
    }
  });
  it('copies caller data and preserves ordinary JSON metadata', () => {
    const input = { ...envelope, command: { type: 'interactiveMutation', resources: ['project:p'], mutation: { kind: 'updateTask', arguments: { taskId: 't', metadata: { receipt: null } } } } };
    const result = normalizeCommand(input);
    input.command.mutation.arguments.taskId = 'changed';
    expect(JSON.stringify(result)).toContain('\"taskId\":\"t\"');
  });
  it('accepts exact query types and rejects unknown fields', () => {
    const query = { protocol: 'task-authority-query/v1', vault_scope: 'v', authority_id: 'a', project_id: 'p', issuer_id: 'i' };
    expect(normalizeQuery({ ...query, type: 'getOperation', operation_id: 'o' })).toBeDefined();
    expect(normalizeQuery({ ...query, type: 'getProjectCoordination' })).toBeDefined();
    expect(() => normalizeQuery({ ...query, type: 'getProjectCoordination', operation_id: 'o' })).toThrow();
  });
});
