import {
  normalizePath,
  parseYaml,
  TFile,
  TFolder,
  type App
} from 'obsidian';
import {
  hashVaultChangePlan,
  type ArchiveVaultChangeOperation,
  type MoveVaultChangeOperation,
  type ReplaceAnchoredVaultChangeOperation,
  type SetPropertyVaultChangeOperation,
  type VaultChangeOperation,
  type VaultChangePlan
} from './VaultChangePlan';
import { VaultChangePreconditions } from './VaultChangePreconditions';

export interface ApprovalRequest {
  runId: string;
  planHash: string;
  operationIds: string[];
  approval: {
    kind: 'human';
    source: 'nexus-ui' | 'thinkbox';
    confirmedAt: number;
  };
}

export type VaultOperationStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked_dependency'
  | 'readback_failed'
  | 'rolled_back'
  | 'rollback_failed';

export interface VaultOperationResult {
  operationId: string;
  type: VaultChangeOperation['type'];
  status: VaultOperationStatus;
  startedAt: number;
  finishedAt: number;
  readback?: Record<string, unknown>;
  error?: string;
  rollbackError?: string;
}

export interface VaultChangeApplyResult {
  runId: string;
  planHash: string;
  status: 'completed' | 'completed_with_issues';
  operations: VaultOperationResult[];
}

export interface PreparedVaultEffect {
  apply(): Promise<void>;
  readback(): Promise<Record<string, unknown>>;
  rollback(): Promise<void>;
}

export interface OperationExecutor<TOperation extends VaultChangeOperation> {
  prepare(
    operation: TOperation,
    context: { runId: string; operationId: string }
  ): Promise<PreparedVaultEffect>;
}

type OperationExecutorMap = {
  move: OperationExecutor<MoveVaultChangeOperation>;
  archive: OperationExecutor<ArchiveVaultChangeOperation>;
  setProperty: OperationExecutor<SetPropertyVaultChangeOperation>;
  replaceAnchored: OperationExecutor<ReplaceAnchoredVaultChangeOperation>;
};

export interface VaultChangeApplierDependencies {
  app: App;
  preconditions: VaultChangePreconditions;
  now?: () => number;
}

export class VaultChangeApplier {
  private readonly now: () => number;
  private readonly executors: OperationExecutorMap;

  constructor(private readonly dependencies: VaultChangeApplierDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.executors = {
      move: { prepare: operation => this.prepareMove(operation) },
      archive: { prepare: operation => this.prepareArchive(operation) },
      setProperty: { prepare: operation => this.prepareSetProperty(operation) },
      replaceAnchored: { prepare: operation => this.prepareReplaceAnchored(operation) }
    };
  }

  async apply(
    plan: VaultChangePlan,
    request: ApprovalRequest,
    beforeEffects: () => Promise<void> = () => Promise.resolve()
  ): Promise<VaultChangeApplyResult> {
    const operations = this.validateSelection(plan, request);
    await beforeEffects();

    const results: VaultOperationResult[] = [];
    const byId = new Map<string, VaultOperationResult>();
    for (const operation of operations) {
      const blocked = operation.dependsOn.some(dependency =>
        byId.get(dependency)?.status !== 'succeeded'
      );
      if (blocked) {
        const timestamp = this.now();
        const result: VaultOperationResult = {
          operationId: operation.operationId,
          type: operation.type,
          status: 'blocked_dependency',
          startedAt: timestamp,
          finishedAt: timestamp,
          error: 'A selected dependency did not succeed.'
        };
        results.push(result);
        byId.set(operation.operationId, result);
        continue;
      }

      const result = await this.applyOne(plan.runId, operation);
      results.push(result);
      byId.set(operation.operationId, result);
    }

    return {
      runId: plan.runId,
      planHash: request.planHash,
      status: results.every(result => result.status === 'succeeded')
        ? 'completed'
        : 'completed_with_issues',
      operations: results
    };
  }

  private validateSelection(
    plan: VaultChangePlan,
    request: ApprovalRequest
  ): VaultChangeOperation[] {
    assertApprovalRequest(request);
    if (request.runId !== plan.runId) {
      throw new Error('approval runId does not match the plan');
    }
    if (request.planHash !== hashVaultChangePlan(plan)) {
      throw new Error('approval plan hash does not match the plan');
    }

    const selected = new Set<string>();
    for (const operationId of request.operationIds) {
      if (selected.has(operationId)) {
        throw new Error(`duplicate selected operationId: ${operationId}`);
      }
      selected.add(operationId);
    }

    const operationById = new Map(plan.operations.map(operation => [operation.operationId, operation]));
    for (const operationId of selected) {
      if (!operationById.has(operationId)) {
        throw new Error(`unknown selected operationId: ${operationId}`);
      }
    }

    const seen = new Set<string>();
    const operations: VaultChangeOperation[] = [];
    for (const operation of plan.operations) {
      if (!selected.has(operation.operationId)) {
        continue;
      }
      for (const dependency of operation.dependsOn) {
        if (!selected.has(dependency)) {
          throw new Error(
            `selected operation ${operation.operationId} requires selected dependency ${dependency}`
          );
        }
        if (!seen.has(dependency)) {
          throw new Error(
            `selected operation ${operation.operationId} requires dependency ${dependency} earlier in the plan`
          );
        }
      }
      this.dependencies.preconditions.validateModelPaths(operation);
      operations.push(operation);
      seen.add(operation.operationId);
    }
    return operations;
  }

  private async applyOne(
    runId: string,
    operation: VaultChangeOperation
  ): Promise<VaultOperationResult> {
    const startedAt = this.now();
    let effect: PreparedVaultEffect;
    try {
      effect = await this.prepare(operation, { runId, operationId: operation.operationId });
      await this.dependencies.preconditions.assertCurrent(operation.preconditions);
      await effect.apply();
    } catch (error) {
      return {
        operationId: operation.operationId,
        type: operation.type,
        status: 'failed',
        startedAt,
        finishedAt: this.now(),
        error: errorMessage(error)
      };
    }

    try {
      const readback = await effect.readback();
      return {
        operationId: operation.operationId,
        type: operation.type,
        status: 'succeeded',
        startedAt,
        finishedAt: this.now(),
        readback
      };
    } catch (error) {
      const readbackError = errorMessage(error);
      try {
        await effect.rollback();
        return {
          operationId: operation.operationId,
          type: operation.type,
          status: 'rolled_back',
          startedAt,
          finishedAt: this.now(),
          error: readbackError
        };
      } catch (rollbackError) {
        return {
          operationId: operation.operationId,
          type: operation.type,
          status: 'rollback_failed',
          startedAt,
          finishedAt: this.now(),
          error: readbackError,
          rollbackError: errorMessage(rollbackError)
        };
      }
    }
  }

  private prepare(
    operation: VaultChangeOperation,
    context: { runId: string; operationId: string }
  ): Promise<PreparedVaultEffect> {
    switch (operation.type) {
      case 'move':
        return this.executors.move.prepare(operation, context);
      case 'archive':
        return this.executors.archive.prepare(operation, context);
      case 'setProperty':
        return this.executors.setProperty.prepare(operation, context);
      case 'replaceAnchored':
        return this.executors.replaceAnchored.prepare(operation, context);
    }
  }

  private async prepareMove(operation: MoveVaultChangeOperation): Promise<PreparedVaultEffect> {
    const sourcePath = this.dependencies.preconditions.resolveModelPath(operation.sourcePath);
    const destinationPath = this.dependencies.preconditions.resolveModelPath(operation.destinationPath);
    return this.prepareRename(sourcePath, destinationPath);
  }

  private async prepareArchive(operation: ArchiveVaultChangeOperation): Promise<PreparedVaultEffect> {
    const sourcePath = this.dependencies.preconditions.resolveModelPath(operation.path);
    const timestamp = formatArchiveTimestamp(new Date(this.now()));
    let suffix = 0;
    let destinationPath: string;
    do {
      const bucket = suffix === 0 ? timestamp : `${timestamp}-${suffix}`;
      destinationPath = this.dependencies.preconditions.resolveGeneratedArchivePath(
        `.archive/${bucket}/${sourcePath}`
      );
      suffix += 1;
    } while (this.dependencies.app.vault.getAbstractFileByPath(destinationPath) !== null);
    return this.prepareRename(sourcePath, destinationPath);
  }

  private prepareRename(
    sourcePath: string,
    destinationPath: string
  ): Promise<PreparedVaultEffect> {
    const { app } = this.dependencies;
    return Promise.resolve({
      apply: async () => {
        const source = app.vault.getAbstractFileByPath(sourcePath);
        if (!(source instanceof TFile) && !(source instanceof TFolder)) {
          throw new Error(`rename source is unavailable: ${sourcePath}`);
        }
        if (app.vault.getAbstractFileByPath(destinationPath) !== null) {
          throw new Error(`rename destination already exists: ${destinationPath}`);
        }
        await ensureParentFolders(app, destinationPath);
        await app.fileManager.renameFile(source, destinationPath);
      },
      readback: () => {
        const sourceExists = app.vault.getAbstractFileByPath(sourcePath) !== null;
        const destinationExists = app.vault.getAbstractFileByPath(destinationPath) !== null;
        if (sourceExists || !destinationExists) {
          throw new Error('authoritative rename readback failed');
        }
        return Promise.resolve({ sourcePath, sourceExists, destinationPath, destinationExists });
      },
      rollback: async () => {
        const destination = app.vault.getAbstractFileByPath(destinationPath);
        if (!(destination instanceof TFile) && !(destination instanceof TFolder)) {
          throw new Error(`rollback source is unavailable: ${destinationPath}`);
        }
        if (app.vault.getAbstractFileByPath(sourcePath) !== null) {
          throw new Error(`rollback destination already exists: ${sourcePath}`);
        }
        await ensureParentFolders(app, sourcePath);
        await app.fileManager.renameFile(destination, sourcePath);
        const sourceExists = app.vault.getAbstractFileByPath(sourcePath) !== null;
        const destinationExists = app.vault.getAbstractFileByPath(destinationPath) !== null;
        if (!sourceExists || destinationExists) {
          throw new Error('authoritative rollback readback failed');
        }
      }
    });
  }

  private async prepareSetProperty(
    operation: SetPropertyVaultChangeOperation
  ): Promise<PreparedVaultEffect> {
    const { app } = this.dependencies;
    const path = this.dependencies.preconditions.resolveModelPath(operation.path);
    const file = requireFile(app, path);
    const original = await app.vault.read(file);
    return {
      apply: async () => {
        if (await app.vault.read(file) !== original) {
          throw new Error(`file changed after preparation: ${path}`);
        }
        await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter[operation.property] = operation.value;
        });
      },
      readback: async () => {
        const frontmatter = readFrontmatter(await app.vault.read(file));
        if (!Object.prototype.hasOwnProperty.call(frontmatter, operation.property)
          || !jsonEqual(frontmatter[operation.property], operation.value)) {
          throw new Error('authoritative setProperty readback failed');
        }
        return { path, property: operation.property, value: frontmatter[operation.property] };
      },
      rollback: async () => {
        await app.vault.process(file, () => original);
        if (await app.vault.read(file) !== original) {
          throw new Error('authoritative rollback readback failed');
        }
      }
    };
  }

  private async prepareReplaceAnchored(
    operation: ReplaceAnchoredVaultChangeOperation
  ): Promise<PreparedVaultEffect> {
    const { app } = this.dependencies;
    const path = this.dependencies.preconditions.resolveModelPath(operation.path);
    const file = requireFile(app, path);
    const original = await app.vault.read(file);
    const expected = replaceAnchoredText(
      original,
      operation.startAnchor,
      operation.endAnchor,
      operation.replacement
    );
    return {
      apply: async () => {
        await app.vault.process(file, current => {
          if (current !== original) {
            throw new Error(`file changed after preparation: ${path}`);
          }
          return expected;
        });
      },
      readback: async () => {
        const current = await app.vault.read(file);
        if (current !== expected) {
          throw new Error('authoritative replaceAnchored readback failed');
        }
        return { path, contentMatches: true };
      },
      rollback: async () => {
        await app.vault.process(file, () => original);
        if (await app.vault.read(file) !== original) {
          throw new Error('authoritative rollback readback failed');
        }
      }
    };
  }
}

function assertApprovalRequest(request: ApprovalRequest): void {
  if (!request || typeof request !== 'object'
    || !request.approval
    || request.approval.kind !== 'human'
    || (request.approval.source !== 'nexus-ui' && request.approval.source !== 'thinkbox')
    || !Number.isFinite(request.approval.confirmedAt)) {
    throw new Error('explicit human approval context is required');
  }
  if (typeof request.runId !== 'string'
    || typeof request.planHash !== 'string'
    || !Array.isArray(request.operationIds)
    || request.operationIds.some(operationId => typeof operationId !== 'string')) {
    throw new Error('invalid approval request');
  }
}

function requireFile(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    throw new Error(`vault file is unavailable: ${path}`);
  }
  return file;
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
  const parent = normalizePath(path).split('/').slice(0, -1);
  let current = '';
  for (const segment of parent) {
    current = current ? `${current}/${segment}` : segment;
    const item = app.vault.getAbstractFileByPath(current);
    if (item instanceof TFolder) {
      continue;
    }
    if (item !== null) {
      throw new Error(`parent path is not a folder: ${current}`);
    }
    await app.vault.createFolder(current);
  }
}

function formatArchiveTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

function readFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {};
  }
  const value: unknown = parseYaml(match[1]);
  return isRecord(value) ? value : {};
}

function replaceAnchoredText(
  content: string,
  startAnchor: string,
  endAnchor: string,
  replacement: string
): string {
  const lines = normalizeCrlf(content).split('\n');
  const startMatches = findLineBlocks(lines, startAnchor);
  const endMatches = findLineBlocks(lines, endAnchor);
  if (startMatches.length !== 1) {
    throw new Error(`replaceAnchored start anchor matched ${startMatches.length} locations`);
  }
  if (endMatches.length !== 1) {
    throw new Error(`replaceAnchored end anchor matched ${endMatches.length} locations`);
  }
  const start = startMatches[0];
  const end = endMatches[0];
  if (end.end < start.start) {
    throw new Error('replaceAnchored end anchor precedes start anchor');
  }
  const replacementLines = replacement === '' ? [] : normalizeCrlf(replacement).split('\n');
  return [
    ...lines.slice(0, start.start),
    ...replacementLines,
    ...lines.slice(end.end + 1)
  ].join('\n');
}

function findLineBlocks(lines: string[], anchor: string): Array<{ start: number; end: number }> {
  const anchorLines = normalizeCrlf(anchor).split('\n');
  const matches: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= lines.length - anchorLines.length; index += 1) {
    if (anchorLines.every((line, offset) => lines[index + offset] === line)) {
      matches.push({ start: index, end: index + anchorLines.length - 1 });
    }
  }
  return matches;
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && jsonEqual(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
