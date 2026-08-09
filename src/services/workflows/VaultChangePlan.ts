const MAX_RAW_PLAN_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 100;
const PLAN_SCHEMA = 'vault-change-plan/v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface ExpectedPlanIdentity {
  runId: string;
  workflowId: string;
  promptHash: string;
  workflowHash: string;
  workspaceId: string;
}

export interface VaultChangeEvidenceReference {
  evidenceId: string;
  path: string;
  excerpt: string;
  contentHash?: string;
}

export interface VaultChangeFinding {
  findingId: string;
  summary: string;
  evidence: string[];
}

export interface VaultChangeRecommendation {
  recommendationId: string;
  findingId: string;
  summary: string;
  evidence: string[];
}

export interface VaultChangePrecondition {
  path: string;
  exists: boolean;
  contentHash?: string;
}

export interface VaultChangeRisk {
  level: 'low' | 'medium' | 'high';
  explanation: string;
}

export interface VaultChangeOperationBase {
  operationId: string;
  findingId: string;
  evidence: string[];
  preconditions: VaultChangePrecondition[];
  expectedEffect: string;
  risk: VaultChangeRisk;
  dependsOn: string[];
  rollback: string;
}

export interface MoveVaultChangeOperation extends VaultChangeOperationBase {
  type: 'move';
  sourcePath: string;
  destinationPath: string;
}

export interface ArchiveVaultChangeOperation extends VaultChangeOperationBase {
  type: 'archive';
  path: string;
}

export interface SetPropertyVaultChangeOperation extends VaultChangeOperationBase {
  type: 'setProperty';
  path: string;
  property: string;
  value: unknown;
}

export interface ReplaceAnchoredVaultChangeOperation extends VaultChangeOperationBase {
  type: 'replaceAnchored';
  path: string;
  startAnchor: string;
  endAnchor: string;
  replacement: string;
}

export type VaultChangeOperation =
  | MoveVaultChangeOperation
  | ArchiveVaultChangeOperation
  | SetPropertyVaultChangeOperation
  | ReplaceAnchoredVaultChangeOperation;

export interface VaultChangePlan extends ExpectedPlanIdentity {
  schema: typeof PLAN_SCHEMA;
  planId: string;
  summary: string;
  findings: VaultChangeFinding[];
  evidenceReferences: VaultChangeEvidenceReference[];
  operations: VaultChangeOperation[];
  recommendations: VaultChangeRecommendation[];
  preservationNotes: string[];
}

/**
 * Parses only a standalone JSON object or a single ```json fence. Validation is
 * deliberately fail-closed: this object later crosses an approval boundary.
 */
export function parseVaultChangePlan(raw: string, expected: ExpectedPlanIdentity): VaultChangePlan {
  if (typeof raw !== 'string') {
    throw new Error('vault change plan output must be a string');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_RAW_PLAN_BYTES) {
    throw new Error('raw plan exceeds 1 MiB');
  }

  const parsed = parseSingleJsonObject(raw);
  validatePlan(parsed, expected);
  return parsed as unknown as VaultChangePlan;
}

/**
 * Produces a stable JSON representation without incorporating the model's raw
 * stdout bytes (fence style, whitespace and object key insertion order).
 */
export function canonicalPlanJson(plan: VaultChangePlan): string {
  return canonicalJson(plan, new Set<object>());
}

export function hashVaultChangePlan(plan: VaultChangePlan): string {
  return `sha256:${sha256Hex(canonicalPlanJson(plan))}`;
}

function parseSingleJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
  const json = fenced ? fenced[1] : trimmed;

  if (!json.startsWith('{') || !json.endsWith('}')) {
    throw new Error('plan output must be a single JSON object or json fence');
  }

  try {
    assertNoDuplicateJsonKeys(json);
    return expectRecord(JSON.parse(json), 'plan');
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('plan output must be a single JSON object or json fence');
    }
    throw error;
  }
}

function validatePlan(plan: Record<string, unknown>, expected: ExpectedPlanIdentity): void {
  assertKnownKeys(plan, [
    'schema', 'planId', 'runId', 'workflowId', 'promptHash', 'workflowHash',
    'workspaceId', 'summary', 'findings', 'evidenceReferences', 'operations',
    'recommendations', 'preservationNotes'
  ], 'plan');

  if (plan.schema !== PLAN_SCHEMA) {
    throw new Error(`unsupported plan schema: ${String(plan.schema)}`);
  }
  assertNonBlankString(plan.planId, 'planId');
  assertNonBlankString(plan.summary, 'summary');
  validateIdentity(plan, expected);

  const evidenceIds = validateEvidenceReferences(plan.evidenceReferences);
  const findingIds = validateFindings(plan.findings, evidenceIds);
  validateOperations(plan.operations, findingIds, evidenceIds);
  validateRecommendations(plan.recommendations, findingIds, evidenceIds);
  validatePreservationNotes(plan.preservationNotes);
}

function validateIdentity(plan: Record<string, unknown>, expected: ExpectedPlanIdentity): void {
  for (const field of ['runId', 'workflowId', 'promptHash', 'workflowHash', 'workspaceId'] as const) {
    assertNonBlankString(plan[field], field);
    if (plan[field] !== expected[field]) {
      throw new Error(`identity mismatch: ${field}`);
    }
  }
  assertSha256(plan.promptHash, 'promptHash');
  assertSha256(plan.workflowHash, 'workflowHash');
}

function validateEvidenceReferences(value: unknown): Set<string> {
  const evidence = expectArray(value, 'evidenceReferences');
  const ids = new Set<string>();
  for (const item of evidence) {
    const reference = expectRecord(item, 'evidence reference');
    assertKnownKeys(reference, ['evidenceId', 'path', 'excerpt', 'contentHash'], 'evidence reference');
    const evidenceId = assertNonBlankString(reference.evidenceId, 'evidenceId');
    assertUnique(ids, evidenceId, 'evidenceId');
    assertVaultPath(reference.path, 'evidence path');
    assertNonBlankString(reference.excerpt, 'evidence excerpt');
    if (reference.contentHash !== undefined) {
      assertSha256(reference.contentHash, 'evidence contentHash');
    }
  }
  return ids;
}

function validateFindings(value: unknown, evidenceIds: Set<string>): Set<string> {
  const findings = expectArray(value, 'findings');
  const ids = new Set<string>();
  for (const item of findings) {
    const finding = expectRecord(item, 'finding');
    assertKnownKeys(finding, ['findingId', 'summary', 'evidence'], 'finding');
    const findingId = assertNonBlankString(finding.findingId, 'findingId');
    assertUnique(ids, findingId, 'findingId');
    assertNonBlankString(finding.summary, 'finding summary');
    validateEvidenceIds(finding.evidence, evidenceIds, 'finding evidence');
  }
  return ids;
}

function validateOperations(value: unknown, findingIds: Set<string>, evidenceIds: Set<string>): void {
  const operations = expectArray(value, 'operations');
  if (operations.length > MAX_OPERATIONS) {
    throw new Error('plan has more than 100 operations');
  }

  const operationIds = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const item of operations) {
    const operation = expectRecord(item, 'operation');
    const operationId = validateOperation(operation, findingIds, evidenceIds);
    assertUnique(operationIds, operationId, 'operationId');
    dependencies.set(operationId, operation.dependsOn as string[]);
  }

  for (const [operationId, dependsOn] of dependencies) {
    for (const dependency of dependsOn) {
      if (!operationIds.has(dependency)) {
        throw new Error(`missing dependency "${dependency}" for operation "${operationId}"`);
      }
    }
  }
  assertAcyclicDependencies(dependencies);
}

function validateOperation(
  operation: Record<string, unknown>,
  findingIds: Set<string>,
  evidenceIds: Set<string>
): string {
  const type = operation.type;
  const commonKeys = [
    'operationId', 'findingId', 'type', 'evidence', 'preconditions',
    'expectedEffect', 'risk', 'dependsOn', 'rollback'
  ];
  switch (type) {
    case 'move': {
      assertKnownKeys(operation, [...commonKeys, 'sourcePath', 'destinationPath'], 'move operation');
      const sourcePath = assertVaultPath(operation.sourcePath, 'move sourcePath');
      const destinationPath = assertVaultPath(operation.destinationPath, 'move destinationPath');
      if (sourcePath.normalize('NFKC') === destinationPath.normalize('NFKC')) {
        throw new Error('move sourcePath and destinationPath must differ');
      }
      break;
    }
    case 'archive':
      assertKnownKeys(operation, [...commonKeys, 'path'], 'archive operation');
      assertVaultPath(operation.path, 'archive path');
      break;
    case 'setProperty':
      assertKnownKeys(operation, [...commonKeys, 'path', 'property', 'value'], 'setProperty operation');
      assertVaultPath(operation.path, 'setProperty path');
      assertSafeSetPropertyName(operation.property);
      assertJsonValue(operation.value, 'setProperty value');
      break;
    case 'replaceAnchored': {
      assertKnownKeys(operation, [...commonKeys, 'path', 'startAnchor', 'endAnchor', 'replacement'], 'replaceAnchored operation');
      assertVaultPath(operation.path, 'replaceAnchored path');
      const startAnchor = assertCanonicalText(operation.startAnchor, 'replaceAnchored startAnchor', false);
      const endAnchor = assertCanonicalText(operation.endAnchor, 'replaceAnchored endAnchor', false);
      if (startAnchor.normalize('NFKC') === endAnchor.normalize('NFKC')) {
        throw new Error('replaceAnchored anchors must differ');
      }
      assertString(operation.replacement, 'replaceAnchored replacement');
      break;
    }
    default:
      throw new Error(`unsupported operation type: ${String(type)}`);
  }

  const operationId = assertNonBlankString(operation.operationId, 'operationId');
  const findingId = assertNonBlankString(operation.findingId, 'operation findingId');
  if (!findingIds.has(findingId)) {
    throw new Error(`unknown findingId "${findingId}"`);
  }
  validateEvidenceIds(operation.evidence, evidenceIds, 'operation evidence');
  const preconditions = validatePreconditions(operation.preconditions);
  validateOperationPreconditions(type, operation, preconditions);
  assertNonBlankString(operation.expectedEffect, 'expectedEffect');
  validateRisk(operation.risk);
  validateDependencies(operation.dependsOn);
  assertNonBlankString(operation.rollback, 'rollback');
  return operationId;
}

function validatePreconditions(value: unknown): Map<string, boolean> {
  const preconditions = expectArray(value, 'preconditions');
  if (preconditions.length === 0) {
    throw new Error('preconditions must not be empty');
  }
  const paths = new Map<string, boolean>();
  for (const item of preconditions) {
    const precondition = expectRecord(item, 'precondition');
    assertKnownKeys(precondition, ['path', 'exists', 'contentHash'], 'precondition');
    const path = assertVaultPath(precondition.path, 'precondition path');
    if (typeof precondition.exists !== 'boolean') {
      throw new Error('precondition exists must be boolean');
    }
    if (paths.has(path)) {
      throw new Error(`duplicate or contradictory precondition path: ${path}`);
    }
    paths.set(path, precondition.exists);
    if (precondition.contentHash !== undefined) {
      if (!precondition.exists) {
        throw new Error('absent precondition must not contain contentHash');
      }
      assertSha256(precondition.contentHash, 'precondition contentHash');
    }
  }
  return paths;
}

function validateOperationPreconditions(
  type: unknown,
  operation: Record<string, unknown>,
  preconditions: Map<string, boolean>
): void {
  switch (type) {
    case 'move':
      assertOnlyTargetPreconditions(preconditions, [
        { path: operation.sourcePath as string, exists: true, label: 'move sourcePath' },
        { path: operation.destinationPath as string, exists: false, label: 'move destinationPath' }
      ]);
      return;
    case 'archive':
      assertOnlyTargetPreconditions(preconditions, [
        { path: operation.path as string, exists: true, label: 'archive path' }
      ]);
      return;
    case 'setProperty':
      assertOnlyTargetPreconditions(preconditions, [
        { path: operation.path as string, exists: true, label: 'setProperty path' }
      ]);
      return;
    case 'replaceAnchored':
      assertOnlyTargetPreconditions(preconditions, [
        { path: operation.path as string, exists: true, label: 'replaceAnchored path' }
      ]);
      return;
    default:
      return;
  }
}

function assertOnlyTargetPreconditions(
  preconditions: Map<string, boolean>,
  targets: Array<{ path: string; exists: boolean; label: string }>
): void {
  for (const target of targets) {
    if (preconditions.get(target.path) !== target.exists) {
      const state = target.exists ? 'existing' : 'absent';
      throw new Error(`${target.label} must have an ${state} precondition`);
    }
  }
  if (preconditions.size !== targets.length) {
    throw new Error('preconditions must not contain unrelated paths');
  }
}

function validateRisk(value: unknown): void {
  const risk = expectRecord(value, 'risk');
  assertKnownKeys(risk, ['level', 'explanation'], 'risk');
  if (risk.level !== 'low' && risk.level !== 'medium' && risk.level !== 'high') {
    throw new Error('risk level must be low, medium, or high');
  }
  assertNonBlankString(risk.explanation, 'risk explanation');
}

function validateDependencies(value: unknown): void {
  const dependencies = expectArray(value, 'dependsOn');
  const ids = new Set<string>();
  for (const item of dependencies) {
    const id = assertNonBlankString(item, 'dependency operationId');
    assertUnique(ids, id, 'dependency operationId');
  }
}

function validateRecommendations(value: unknown, findingIds: Set<string>, evidenceIds: Set<string>): void {
  const recommendations = expectArray(value, 'recommendations');
  const ids = new Set<string>();
  for (const item of recommendations) {
    const recommendation = expectRecord(item, 'recommendation');
    assertKnownKeys(recommendation, ['recommendationId', 'findingId', 'summary', 'evidence'], 'recommendation');
    const recommendationId = assertNonBlankString(recommendation.recommendationId, 'recommendationId');
    assertUnique(ids, recommendationId, 'recommendationId');
    const findingId = assertNonBlankString(recommendation.findingId, 'recommendation findingId');
    if (!findingIds.has(findingId)) {
      throw new Error(`unknown findingId "${findingId}"`);
    }
    assertNonBlankString(recommendation.summary, 'recommendation summary');
    validateEvidenceIds(recommendation.evidence, evidenceIds, 'recommendation evidence');
  }
}

function validatePreservationNotes(value: unknown): void {
  for (const note of expectArray(value, 'preservationNotes')) {
    assertNonBlankString(note, 'preservation note');
  }
}

function validateEvidenceIds(value: unknown, available: Set<string>, label: string): void {
  const ids = expectArray(value, label);
  if (ids.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const used = new Set<string>();
  for (const item of ids) {
    const id = assertNonBlankString(item, label);
    assertUnique(used, id, label);
    if (!available.has(id)) {
      throw new Error(`unknown evidenceId "${id}"`);
    }
  }
}

function assertAcyclicDependencies(dependencies: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): void => {
    if (visiting.has(operationId)) {
      throw new Error('operation dependency cycle');
    }
    if (visited.has(operationId)) {
      return;
    }
    visiting.add(operationId);
    for (const dependency of dependencies.get(operationId) ?? []) {
      visit(dependency);
    }
    visiting.delete(operationId);
    visited.add(operationId);
  };
  for (const operationId of dependencies.keys()) {
    visit(operationId);
  }
}

function assertKnownKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`unknown key "${key}" in ${label}`);
    }
  }
  for (const key of allowed) {
    if (!(key in record) && key !== 'contentHash') {
      throw new Error(`missing key "${key}" in ${label}`);
    }
  }
}

function assertVaultPath(value: unknown, label: string): string {
  const path = assertCanonicalText(value, label, false);
  if (path !== path.trim()
    || path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('~')
    || /^[A-Za-z]:/.test(path)
    || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`invalid vault path: ${path}`);
  }
  return path;
}

function assertSafeSetPropertyName(value: unknown): string {
  const property = assertCanonicalText(value, 'setProperty property', false);
  if (property === '__proto__' || property === 'prototype' || property === 'constructor') {
    throw new Error(`unsafe setProperty property: ${property}`);
  }
  return property;
}

function assertCanonicalText(value: unknown, label: string, allowEmpty: boolean): string {
  const text = assertString(value, label);
  if (!allowEmpty && text.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
  if (text.normalize('NFKC') !== text) {
    throw new Error(`${label} must be NFKC canonical`);
  }
  if (containsUnsafeTextControl(text)) {
    throw new Error(`${label} contains an unsafe control character`);
  }
  return text;
}

function containsUnsafeTextControl(text: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(text);
}

function assertSha256(value: unknown, label: string): string {
  const hash = assertString(value, label);
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`invalid sha256 hash: ${label}`);
  }
  return hash;
}

function assertUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) {
    throw new Error(`duplicate ${label}: ${value}`);
  }
  values.add(value);
}

function assertNonBlankString(value: unknown, label: string): string {
  const string = assertString(value, label);
  if (string.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
  return string;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNoDuplicateJsonKeys(json: string): void {
  const end = scanJsonValue(json, skipJsonWhitespace(json, 0));
  if (skipJsonWhitespace(json, end) !== json.length) {
    throw new Error('plan output must be a single JSON object or json fence');
  }
}

function scanJsonValue(json: string, position: number): number {
  const start = skipJsonWhitespace(json, position);
  const character = json[start];
  if (character === '{') {
    return scanJsonObject(json, start + 1);
  }
  if (character === '[') {
    return scanJsonArray(json, start + 1);
  }
  if (character === '"') {
    return scanJsonString(json, start).end;
  }
  if (json.startsWith('true', start)) {
    return start + 4;
  }
  if (json.startsWith('false', start)) {
    return start + 5;
  }
  if (json.startsWith('null', start)) {
    return start + 4;
  }
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(start));
  if (number) {
    return start + number[0].length;
  }
  throw new Error('plan output must be valid JSON');
}

function scanJsonObject(json: string, position: number): number {
  let cursor = skipJsonWhitespace(json, position);
  const keys = new Set<string>();
  if (json[cursor] === '}') {
    return cursor + 1;
  }
  while (cursor < json.length) {
    const key = scanJsonString(json, cursor);
    if (keys.has(key.value)) {
      throw new Error(`duplicate JSON key "${key.value}"`);
    }
    keys.add(key.value);
    cursor = skipJsonWhitespace(json, key.end);
    if (json[cursor] !== ':') {
      throw new Error('plan output must be valid JSON');
    }
    cursor = scanJsonValue(json, cursor + 1);
    cursor = skipJsonWhitespace(json, cursor);
    if (json[cursor] === '}') {
      return cursor + 1;
    }
    if (json[cursor] !== ',') {
      throw new Error('plan output must be valid JSON');
    }
    cursor = skipJsonWhitespace(json, cursor + 1);
  }
  throw new Error('plan output must be valid JSON');
}

function scanJsonArray(json: string, position: number): number {
  let cursor = skipJsonWhitespace(json, position);
  if (json[cursor] === ']') {
    return cursor + 1;
  }
  while (cursor < json.length) {
    cursor = scanJsonValue(json, cursor);
    cursor = skipJsonWhitespace(json, cursor);
    if (json[cursor] === ']') {
      return cursor + 1;
    }
    if (json[cursor] !== ',') {
      throw new Error('plan output must be valid JSON');
    }
    cursor = skipJsonWhitespace(json, cursor + 1);
  }
  throw new Error('plan output must be valid JSON');
}

function scanJsonString(json: string, position: number): { value: string; end: number } {
  if (json[position] !== '"') {
    throw new Error('plan output must be valid JSON');
  }
  let cursor = position + 1;
  while (cursor < json.length) {
    const character = json[cursor];
    if (character === '"') {
      const raw = json.slice(position, cursor + 1);
      try {
        return { value: JSON.parse(raw) as string, end: cursor + 1 };
      } catch {
        throw new Error('plan output must be valid JSON');
      }
    }
    if (character === '\\') {
      const escaped = json[cursor + 1];
      if (!escaped) {
        throw new Error('plan output must be valid JSON');
      }
      if (escaped === 'u') {
        const hexadecimal = json.slice(cursor + 2, cursor + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) {
          throw new Error('plan output must be valid JSON');
        }
        cursor += 6;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escaped)) {
        throw new Error('plan output must be valid JSON');
      }
      cursor += 2;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw new Error('plan output must be valid JSON');
    }
    cursor += 1;
  }
  throw new Error('plan output must be valid JSON');
}

function skipJsonWhitespace(json: string, position: number): number {
  let cursor = position;
  while (json[cursor] === ' ' || json[cursor] === '\n' || json[cursor] === '\r' || json[cursor] === '\t') {
    cursor += 1;
  }
  return cursor;
}

function assertJsonValue(value: unknown, label: string): void {
  assertSafePropertyJsonValue(value, label, new Set<object>());
  canonicalJson(value, new Set<object>());
}

function assertSafePropertyJsonValue(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    assertDensePlainArray(value);
    ancestors.add(value);
    for (const item of value) {
      assertSafePropertyJsonValue(item, label, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new Error(`${label} must be JSON-serializable`);
    }
    assertPlainJsonObject(value);
    ancestors.add(value);
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`unsafe ${label} key: ${key}`);
      }
      assertSafePropertyJsonValue((value as Record<string, unknown>)[key], label, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw new Error(`${label} must be JSON-serializable`);
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical plan contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error('canonical plan contains a cycle');
    }
    assertDensePlainArray(value);
    ancestors.add(value);
    const json = `[${value.map(item => canonicalJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return json;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new Error('canonical plan contains a cycle');
    }
    assertPlainJsonObject(value);
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const json = `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`
    )).join(',')}}`;
    ancestors.delete(value);
    return json;
  }
  throw new Error('canonical plan contains a non-JSON value');
}

function assertDensePlainArray(value: unknown[]): void {
  if (Reflect.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('canonical plan contains a non-plain array');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new Error('canonical plan contains a sparse array or extra array property');
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error('canonical plan contains a sparse array');
    }
  }
  for (const key of keys) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
      throw new Error('canonical plan contains a non-JSON array property');
    }
  }
}

function assertPlainJsonObject(value: object): void {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('canonical plan contains a non-plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error('canonical plan contains a symbol key');
    }
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new Error('canonical plan contains a non-enumerable property');
    }
  }
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const first = words[index - 15];
      const second = words[index - 2];
      const smallSigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const smallSigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, word => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
