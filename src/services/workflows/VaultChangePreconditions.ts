import { normalizePath, TFile, type Vault } from 'obsidian';
import type {
  VaultChangeOperation,
  VaultChangePrecondition
} from './VaultChangePlan';

type ContentHasher = (content: string) => Promise<string>;

export class VaultChangePreconditions {
  private readonly hashContent: ContentHasher;

  constructor(
    private readonly vault: Vault,
    hashContent: ContentHasher = hashUtf8
  ) {
    this.hashContent = hashContent;
  }

  validateModelPaths(operation: VaultChangeOperation): void {
    for (const path of this.operationPaths(operation)) {
      this.resolveModelPath(path);
    }
    for (const precondition of operation.preconditions) {
      this.resolveModelPath(precondition.path);
    }
  }

  resolveModelPath(path: string): string {
    const normalized = normalizePath(path);
    const firstSegment = normalized.split('/')[0] ?? '';
    if (
      firstSegment.startsWith('.')
      || normalized === '_Base/Dados'
      || normalized.startsWith('_Base/Dados/')
      || normalized === '_Base/PluginsSync'
      || normalized.startsWith('_Base/PluginsSync/')
    ) {
      throw new Error(`protected vault path: ${path}`);
    }
    return normalized;
  }

  resolveGeneratedArchivePath(path: string): string {
    const normalized = normalizePath(path);
    if (!normalized.startsWith('.archive/')) {
      throw new Error(`invalid generated archive path: ${path}`);
    }
    return normalized;
  }

  async assertCurrent(preconditions: readonly VaultChangePrecondition[]): Promise<void> {
    for (const precondition of preconditions) {
      const path = this.resolveModelPath(precondition.path);
      const item = this.vault.getAbstractFileByPath(path);
      const exists = item !== null;
      if (exists !== precondition.exists) {
        throw new Error(`precondition failed for ${path}: expected exists=${precondition.exists}`);
      }
      if (precondition.contentHash !== undefined) {
        if (!(item instanceof TFile)) {
          throw new Error(`precondition failed for ${path}: content hash requires a file`);
        }
        const currentHash = await this.hashContent(await this.vault.read(item));
        if (currentHash !== precondition.contentHash) {
          throw new Error(`precondition failed for ${path}: content hash mismatch`);
        }
      }
    }
  }

  private operationPaths(operation: VaultChangeOperation): string[] {
    switch (operation.type) {
      case 'move':
        return [operation.sourcePath, operation.destinationPath];
      case 'archive':
      case 'setProperty':
      case 'replaceAnchored':
        return [operation.path];
    }
  }
}

async function hashUtf8(content: string): Promise<string> {
  if (!window.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable for vault preconditions');
  }
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content)
  );
  const hex = Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}
