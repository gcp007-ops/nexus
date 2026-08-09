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

export interface LegacyVaultChangeApplyReceipt {
  schema: 'agent-run-apply-receipt/v1';
  runId: string;
  planHash: string;
  operationIds: string[];
  operations: VaultOperationResult[];
}

export type VaultOperationExpectedReadback =
  | {
    kind: 'rename';
    sourcePath: string;
    destinationPath: string;
  }
  | {
    kind: 'setProperty';
    path: string;
    property: string;
    value: unknown;
  }
  | {
    kind: 'contentHash';
    path: string;
    contentHash: string;
  };

export interface VaultOperationWriteAhead {
  operationId: string;
  type: VaultChangeOperation['type'];
  dependsOn: string[];
  startedAt: number;
  expectedReadback: VaultOperationExpectedReadback;
}

interface VaultOperationReceiptBase {
  operationId: string;
  type: VaultChangeOperation['type'];
  dependsOn: string[];
  selectedAt: number;
}

export type VaultOperationApplyReceipt =
  | (VaultOperationReceiptBase & { state: 'selected' })
  | (VaultOperationReceiptBase & {
    state: 'pending';
    startedAt: number;
    expectedReadback: VaultOperationExpectedReadback;
  })
  | (VaultOperationReceiptBase & {
    state: 'settled';
    result: VaultOperationResult;
    startedAt?: number;
    expectedReadback?: VaultOperationExpectedReadback;
  });

export interface DurableVaultChangeApplyReceipt {
  schema: 'agent-run-apply-receipt/v2';
  runId: string;
  planHash: string;
  operationIds: string[];
  operations: VaultOperationApplyReceipt[];
}

export type VaultChangeApplyReceipt =
  | LegacyVaultChangeApplyReceipt
  | DurableVaultChangeApplyReceipt;

export interface PreparedVaultEffect {
  expectedReadback: VaultOperationExpectedReadback;
  apply(): Promise<void>;
  readback(): Promise<Record<string, unknown>>;
  rollback(): Promise<void>;
  currentState(): Promise<Record<string, unknown>>;
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
    beforeEffects: () => Promise<void> = () => Promise.resolve(),
    afterOperation: (result: VaultOperationResult) => Promise<void> = () => Promise.resolve(),
    beforeOperation?: (writeAhead: VaultOperationWriteAhead) => Promise<void>
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
        await afterOperation(result);
        continue;
      }

      const result = await this.applyOne(plan.runId, operation, beforeOperation);
      results.push(result);
      byId.set(operation.operationId, result);
      await afterOperation(result);
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

  async reconcile(
    plan: VaultChangePlan,
    receipt: VaultChangeApplyReceipt
  ): Promise<VaultChangeApplyResult> {
    this.validateReceipt(plan, receipt);
    if (receipt.schema === 'agent-run-apply-receipt/v2') {
      return this.reconcileDurableReceipt(plan, receipt);
    }
    const operationById = new Map(plan.operations.map(operation => [operation.operationId, operation]));
    for (const result of receipt.operations) {
      const operation = operationById.get(result.operationId);
      if (!operation) {
        throw new Error(`receipt contains unknown operationId: ${result.operationId}`);
      }
      await this.assertReceiptReadback(operation, result);
    }
    const status = receipt.operations.every(result => result.status === 'succeeded')
      ? 'completed'
      : 'completed_with_issues';
    return {
      runId: receipt.runId,
      planHash: receipt.planHash,
      status,
      operations: receipt.operations.map(result => ({ ...result }))
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

  private validateReceipt(plan: VaultChangePlan, receipt: VaultChangeApplyReceipt): void {
    if ((receipt.schema !== 'agent-run-apply-receipt/v1'
        && receipt.schema !== 'agent-run-apply-receipt/v2')
      || receipt.runId !== plan.runId
      || receipt.planHash !== hashVaultChangePlan(plan)) {
      throw new Error('apply receipt does not match the immutable plan');
    }
    if (receipt.operationIds.length !== receipt.operations.length
      || receipt.operationIds.some((operationId, index) =>
        operationId !== receipt.operations[index]?.operationId)) {
      throw new Error('apply receipt is incomplete or out of order');
    }
    const selected = new Set<string>();
    for (const operationId of receipt.operationIds) {
      if (selected.has(operationId)) {
        throw new Error(`apply receipt repeats operationId: ${operationId}`);
      }
      selected.add(operationId);
    }
    const expectedOrder = plan.operations
      .filter(operation => selected.has(operation.operationId))
      .map(operation => operation.operationId);
    if (expectedOrder.length !== receipt.operationIds.length
      || expectedOrder.some((operationId, index) => operationId !== receipt.operationIds[index])) {
      throw new Error('apply receipt selection does not match plan order');
    }
    for (const operation of plan.operations) {
      if (!selected.has(operation.operationId)) continue;
      for (const dependency of operation.dependsOn) {
        if (!selected.has(dependency)) {
          throw new Error(
            `apply receipt operation ${operation.operationId} lacks dependency ${dependency}`
          );
        }
      }
    }
    if (receipt.schema === 'agent-run-apply-receipt/v1') {
      return;
    }

    let foundUnsettled = false;
    let pendingCount = 0;
    for (let index = 0; index < receipt.operations.length; index += 1) {
      const entry = receipt.operations[index];
      const operation = plan.operations.find(item => item.operationId === entry.operationId);
      if (!operation
        || entry.type !== operation.type
        || !stringArraysEqual(entry.dependsOn, operation.dependsOn)
        || typeof entry.selectedAt !== 'number'
        || !Number.isFinite(entry.selectedAt)) {
        throw new Error(`invalid durable receipt identity for ${entry.operationId}`);
      }
      if (entry.state === 'selected') {
        assertOnlyKeys(entry as unknown as Record<string, unknown>, [
          'operationId', 'type', 'dependsOn', 'selectedAt', 'state'
        ]);
        foundUnsettled = true;
        continue;
      }
      if (entry.state === 'pending') {
        assertOnlyKeys(entry as unknown as Record<string, unknown>, [
          'operationId', 'type', 'dependsOn', 'selectedAt', 'state', 'startedAt', 'expectedReadback'
        ]);
        if (foundUnsettled || pendingCount > 0
          || typeof entry.startedAt !== 'number'
          || !Number.isFinite(entry.startedAt)) {
          throw new Error('durable receipt contains an invalid pending operation order');
        }
        pendingCount += 1;
        foundUnsettled = true;
        this.assertExpectedReadback(operation, entry.expectedReadback);
        continue;
      }
      assertOnlyKeys(entry as unknown as Record<string, unknown>, [
        'operationId', 'type', 'dependsOn', 'selectedAt', 'state', 'result',
        'startedAt', 'expectedReadback'
      ]);
      if (foundUnsettled) {
        throw new Error('durable receipt contains a settled operation after an unsettled predecessor');
      }
      if (!isVaultOperationResult(entry.result)
        || entry.result.operationId !== entry.operationId
        || entry.result.type !== entry.type) {
        throw new Error(`invalid durable receipt result for ${entry.operationId}`);
      }
      if (entry.expectedReadback !== undefined) {
        if (typeof entry.startedAt !== 'number' || !Number.isFinite(entry.startedAt)) {
          throw new Error(`durable receipt lacks write-ahead time for ${entry.operationId}`);
        }
        this.assertExpectedReadback(operation, entry.expectedReadback);
      } else if (entry.startedAt !== undefined) {
        throw new Error(`durable receipt has a write-ahead time without descriptor for ${entry.operationId}`);
      }
    }
  }

  private async reconcileDurableReceipt(
    plan: VaultChangePlan,
    receipt: DurableVaultChangeApplyReceipt
  ): Promise<VaultChangeApplyResult> {
    const operationById = new Map(plan.operations.map(operation => [operation.operationId, operation]));
    const results: VaultOperationResult[] = [];
    const byId = new Map<string, VaultOperationResult>();
    for (const entry of receipt.operations) {
      const operation = operationById.get(entry.operationId);
      if (!operation) {
        throw new Error(`receipt contains unknown operationId: ${entry.operationId}`);
      }
      let result: VaultOperationResult;
      if (entry.state === 'settled') {
        result = cloneJson(entry.result);
        await this.assertReceiptReadback(operation, result);
      } else if (entry.state === 'pending') {
        try {
          const recovery = await this.readExpectedState(entry.expectedReadback);
          result = {
            operationId: entry.operationId,
            type: entry.type,
            status: recovery.matches ? 'succeeded' : 'readback_failed',
            startedAt: entry.startedAt,
            finishedAt: entry.startedAt,
            readback: recovery.readback,
            ...(recovery.matches ? {} : {
              error: 'Authoritative recovery readback found unresolved or drifted state.'
            })
          };
        } catch (error) {
          result = {
            operationId: entry.operationId,
            type: entry.type,
            status: 'readback_failed',
            startedAt: entry.startedAt,
            finishedAt: entry.startedAt,
            error: `Authoritative recovery readback is unavailable: ${errorMessage(error)}`
          };
        }
      } else {
        const blocked = entry.dependsOn.some(dependency => byId.get(dependency)?.status !== 'succeeded');
        result = {
          operationId: entry.operationId,
          type: entry.type,
          status: blocked ? 'blocked_dependency' : 'failed',
          startedAt: entry.selectedAt,
          finishedAt: entry.selectedAt,
          error: blocked
            ? 'A selected dependency was unresolved during recovery.'
            : 'Application stopped before this effect was write-ahead persisted.'
        };
      }
      results.push(result);
      byId.set(result.operationId, result);
    }
    return {
      runId: receipt.runId,
      planHash: receipt.planHash,
      status: results.every(result => result.status === 'succeeded')
        ? 'completed'
        : 'completed_with_issues',
      operations: results
    };
  }

  private async readExpectedState(expected: VaultOperationExpectedReadback): Promise<{
    matches: boolean;
    readback: Record<string, unknown>;
  }> {
    if (expected.kind === 'rename') {
      const readback = {
        sourcePath: expected.sourcePath,
        sourceExists: this.dependencies.app.vault.getAbstractFileByPath(expected.sourcePath) !== null,
        destinationPath: expected.destinationPath,
        destinationExists: this.dependencies.app.vault.getAbstractFileByPath(expected.destinationPath) !== null
      };
      return {
        matches: !readback.sourceExists && readback.destinationExists,
        readback
      };
    }
    if (expected.kind === 'setProperty') {
      const file = requireFile(this.dependencies.app, expected.path);
      const content = await this.dependencies.app.vault.read(file);
      const frontmatter = readFrontmatter(content);
      const valuePresent = Object.prototype.hasOwnProperty.call(frontmatter, expected.property);
      const readback = {
        path: expected.path,
        property: expected.property,
        valuePresent,
        ...(valuePresent ? { value: frontmatter[expected.property] } : {}),
        contentHash: await this.dependencies.preconditions.hashExactContent(content)
      };
      return {
        matches: valuePresent && jsonEqual(readback.value, expected.value),
        readback
      };
    }
    const contentHash = await this.dependencies.preconditions.readContentHash(expected.path);
    return {
      matches: contentHash === expected.contentHash,
      readback: { path: expected.path, contentHash }
    };
  }

  private assertExpectedReadback(
    operation: VaultChangeOperation,
    expected: VaultOperationExpectedReadback
  ): void {
    if (!isRecord(expected)) {
      throw new Error(`invalid durable readback descriptor for ${operation.operationId}`);
    }
    if (operation.type === 'move' || operation.type === 'archive') {
      assertOnlyKeys(expected, ['kind', 'sourcePath', 'destinationPath']);
      if (expected.kind !== 'rename') {
        throw new Error(`durable rename descriptor mismatch for ${operation.operationId}`);
      }
      const sourcePath = this.dependencies.preconditions.resolveModelPath(
        operation.type === 'move' ? operation.sourcePath : operation.path
      );
      const destinationPath = operation.type === 'move'
        ? this.dependencies.preconditions.resolveModelPath(operation.destinationPath)
        : typeof expected.destinationPath === 'string'
          ? this.dependencies.preconditions.resolveGeneratedArchivePath(expected.destinationPath)
          : '';
      if (expected.sourcePath !== sourcePath
        || expected.destinationPath !== destinationPath) {
        throw new Error(`durable rename descriptor mismatch for ${operation.operationId}`);
      }
      return;
    }
    if (operation.type === 'setProperty') {
      assertOnlyKeys(expected, ['kind', 'path', 'property', 'value']);
      if (expected.kind !== 'setProperty'
        || expected.path !== this.dependencies.preconditions.resolveModelPath(operation.path)
        || expected.property !== operation.property
        || !jsonEqual(expected.value, operation.value)) {
        throw new Error(`durable property descriptor mismatch for ${operation.operationId}`);
      }
      return;
    }
    assertOnlyKeys(expected, ['kind', 'path', 'contentHash']);
    if (expected.kind !== 'contentHash'
      || expected.path !== this.dependencies.preconditions.resolveModelPath(operation.path)
      || !/^sha256:[a-f0-9]{64}$/.test(expected.contentHash)) {
      throw new Error(`durable content descriptor mismatch for ${operation.operationId}`);
    }
  }

  private async assertReceiptReadback(
    operation: VaultChangeOperation,
    result: VaultOperationResult
  ): Promise<void> {
    if (result.type !== operation.type) {
      throw new Error(`apply receipt type mismatch for ${operation.operationId}`);
    }
    if (result.status === 'failed' || result.status === 'blocked_dependency') {
      return;
    }
    if (!isRecord(result.readback)) {
      throw new Error(`apply receipt lacks authoritative readback for ${operation.operationId}`);
    }

    if (operation.type === 'move' || operation.type === 'archive') {
      const expectedSource = this.dependencies.preconditions.resolveModelPath(
        operation.type === 'move' ? operation.sourcePath : operation.path
      );
      if (result.readback.sourcePath !== expectedSource
        || typeof result.readback.destinationPath !== 'string'
        || typeof result.readback.sourceExists !== 'boolean'
        || typeof result.readback.destinationExists !== 'boolean') {
        throw new Error(`invalid rename receipt readback for ${operation.operationId}`);
      }
      const destination = operation.type === 'move'
        ? this.dependencies.preconditions.resolveModelPath(operation.destinationPath)
        : this.dependencies.preconditions.resolveGeneratedArchivePath(result.readback.destinationPath);
      if (destination !== result.readback.destinationPath) {
        throw new Error(`rename receipt destination mismatch for ${operation.operationId}`);
      }
      const sourceExists = this.dependencies.app.vault.getAbstractFileByPath(expectedSource) !== null;
      const destinationExists = this.dependencies.app.vault.getAbstractFileByPath(destination) !== null;
      if (sourceExists !== result.readback.sourceExists
        || destinationExists !== result.readback.destinationExists) {
        throw new Error(`authoritative receipt readback failed for ${operation.operationId}`);
      }
      return;
    }

    const expectedPath = this.dependencies.preconditions.resolveModelPath(operation.path);
    if (result.readback.path !== expectedPath || typeof result.readback.contentHash !== 'string') {
      throw new Error(`invalid content receipt readback for ${operation.operationId}`);
    }
    const currentHash = await this.dependencies.preconditions.readContentHash(expectedPath);
    if (currentHash !== result.readback.contentHash) {
      throw new Error(`authoritative receipt readback failed for ${operation.operationId}`);
    }
  }

  private async applyOne(
    runId: string,
    operation: VaultChangeOperation,
    beforeOperation?: (writeAhead: VaultOperationWriteAhead) => Promise<void>
  ): Promise<VaultOperationResult> {
    const startedAt = this.now();
    let effect: PreparedVaultEffect;
    try {
      effect = await this.prepare(operation, { runId, operationId: operation.operationId });
      await this.dependencies.preconditions.assertCurrent(operation.preconditions);
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

    if (beforeOperation) {
      await beforeOperation({
        operationId: operation.operationId,
        type: operation.type,
        dependsOn: [...operation.dependsOn],
        startedAt,
        expectedReadback: cloneJson(effect.expectedReadback)
      });
      try {
        await effect.apply();
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
        throw new Error(
          `Vault operation outcome is unknown after durable write-ahead for ${operation.operationId}: ${errorMessage(error)}`
        );
      }
    }

    try {
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
          readback: await effect.currentState(),
          error: readbackError
        };
      } catch (rollbackError) {
        let readback: Record<string, unknown> | undefined;
        try {
          readback = await effect.currentState();
        } catch {
          readback = undefined;
        }
        return {
          operationId: operation.operationId,
          type: operation.type,
          status: 'rollback_failed',
          startedAt,
          finishedAt: this.now(),
          ...(readback ? { readback } : {}),
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
    const currentState = () => Promise.resolve({
      sourcePath,
      sourceExists: app.vault.getAbstractFileByPath(sourcePath) !== null,
      destinationPath,
      destinationExists: app.vault.getAbstractFileByPath(destinationPath) !== null
    });
    return Promise.resolve({
      expectedReadback: { kind: 'rename', sourcePath, destinationPath },
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
      readback: async () => {
        const state = await currentState();
        if (state.sourceExists || !state.destinationExists) {
          throw new Error('authoritative rename readback failed');
        }
        return state;
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
      },
      currentState
    });
  }

  private async prepareSetProperty(
    operation: SetPropertyVaultChangeOperation
  ): Promise<PreparedVaultEffect> {
    const { app } = this.dependencies;
    const path = this.dependencies.preconditions.resolveModelPath(operation.path);
    const file = requireFile(app, path);
    const original = await app.vault.read(file);
    const currentState = async (): Promise<Record<string, unknown>> => {
      const content = await app.vault.read(file);
      const frontmatter = readFrontmatter(content);
      const hasValue = Object.prototype.hasOwnProperty.call(frontmatter, operation.property);
      return {
        path,
        property: operation.property,
        valuePresent: hasValue,
        ...(hasValue ? { value: frontmatter[operation.property] } : {}),
        contentHash: await this.dependencies.preconditions.hashExactContent(content)
      };
    };
    return {
      expectedReadback: {
        kind: 'setProperty',
        path,
        property: operation.property,
        value: cloneJson(operation.value)
      },
      apply: async () => {
        if (await app.vault.read(file) !== original) {
          throw new Error(`file changed after preparation: ${path}`);
        }
        await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter[operation.property] = operation.value;
        });
      },
      readback: async () => {
        const state = await currentState();
        if (state.valuePresent !== true || !jsonEqual(state.value, operation.value)) {
          throw new Error('authoritative setProperty readback failed');
        }
        return state;
      },
      rollback: async () => {
        await app.vault.process(file, () => original);
        if (await app.vault.read(file) !== original) {
          throw new Error('authoritative rollback readback failed');
        }
      },
      currentState
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
    const currentState = async (): Promise<Record<string, unknown>> => {
      const content = await app.vault.read(file);
      return {
        path,
        contentHash: await this.dependencies.preconditions.hashExactContent(content)
      };
    };
    return {
      expectedReadback: {
        kind: 'contentHash',
        path,
        contentHash: await this.dependencies.preconditions.hashExactContent(expected)
      },
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
        return currentState();
      },
      rollback: async () => {
        await app.vault.process(file, () => original);
        if (await app.vault.read(file) !== original) {
          throw new Error('authoritative rollback readback failed');
        }
      },
      currentState
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

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(`durable apply receipt contains unknown field: ${unknown}`);
  }
}

function isVaultOperationResult(value: unknown): value is VaultOperationResult {
  return isRecord(value)
    && typeof value.operationId === 'string'
    && (value.type === 'move'
      || value.type === 'archive'
      || value.type === 'setProperty'
      || value.type === 'replaceAnchored')
    && (value.status === 'succeeded'
      || value.status === 'failed'
      || value.status === 'blocked_dependency'
      || value.status === 'readback_failed'
      || value.status === 'rolled_back'
      || value.status === 'rollback_failed')
    && typeof value.startedAt === 'number'
    && Number.isFinite(value.startedAt)
    && typeof value.finishedAt === 'number'
    && Number.isFinite(value.finishedAt)
    && (value.readback === undefined || isRecord(value.readback))
    && (value.error === undefined || typeof value.error === 'string')
    && (value.rollbackError === undefined || typeof value.rollbackError === 'string');
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
