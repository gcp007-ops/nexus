import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSTATION_ROOT = '/Volumes/Dados/qa-temp';

export function createContentCasTestDirectory(prefix: string): string {
  // Keep workstation fixtures outside the live vault. CI and other machines
  // can run the same real-filesystem cases in their system temp directory.
  if (process.platform === 'darwin' && !process.env.CI && existsSync(WORKSTATION_ROOT)) {
    const root = join(WORKSTATION_ROOT, 'nexus', 'ciclo-producao-peca-cas');
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  }

  return mkdtempSync(join(tmpdir(), `nexus-content-cas-${prefix}`));
}
