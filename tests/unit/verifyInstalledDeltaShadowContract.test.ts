import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const verifierName = 'verify-installed-delta-shadow-contract.mjs';
const verifierSource = join(__dirname, '../../scripts', verifierName);

interface PluginIdentity {
  id: string;
  version: string;
}

interface VerifierResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

async function createSourcePlugin(identity: PluginIdentity): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), 'nexus-delta-shadow-source-'));
  const scriptsDirectory = join(source, 'scripts');
  await mkdir(scriptsDirectory);
  await copyFile(verifierSource, join(scriptsDirectory, verifierName));
  await writeFile(join(source, 'manifest.json'), `${JSON.stringify(identity)}\n`);
  await writeFile(join(source, 'main.js'), 'source bundle\n');
  return source;
}

async function createInstalledPlugin(
  source: string,
  identity: PluginIdentity,
  mainContent?: string
): Promise<string> {
  const installed = await mkdtemp(join(tmpdir(), 'nexus-delta-shadow-installed-'));
  await writeFile(join(installed, 'manifest.json'), `${JSON.stringify(identity)}\n`);
  await writeFile(
    join(installed, 'main.js'),
    mainContent ?? await readFile(join(source, 'main.js'), 'utf8')
  );
  return installed;
}

function runVerifier(source: string, installed: string): VerifierResult {
  const result = spawnSync(process.execPath, [join(source, 'scripts', verifierName)], {
    encoding: 'utf8',
    env: { ...process.env, NEXUS_PLUGIN_DIR: installed }
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

describe('verify-installed-delta-shadow-contract', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
      recursive: true,
      force: true
    })));
  });

  it('derives the expected identity from the source fixture manifest', async () => {
    const source = await createSourcePlugin({ id: 'nexus', version: '9.9.9' });
    const installed = await createInstalledPlugin(source, { id: 'nexus', version: '9.9.9' });
    temporaryDirectories.push(source, installed);

    const result = runVerifier(source, installed);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'thinkbox-nexus-delta-shadow-contract/v1',
      version: '9.9.9',
      bundleParity: true
    });
  });

  it('rejects an installed manifest whose version differs from the source', async () => {
    const source = await createSourcePlugin({ id: 'nexus', version: '9.9.9' });
    const installed = await createInstalledPlugin(source, { id: 'nexus', version: '9.9.8' });
    temporaryDirectories.push(source, installed);

    const result = runVerifier(source, installed);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source and installed manifests differ semantically');
  });

  it('rejects a source manifest whose id is not nexus', async () => {
    const source = await createSourcePlugin({ id: 'other-plugin', version: '9.9.9' });
    const installed = await createInstalledPlugin(source, { id: 'other-plugin', version: '9.9.9' });
    temporaryDirectories.push(source, installed);

    const result = runVerifier(source, installed);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source manifest must identify nexus');
  });

  it('rejects an installed main.js whose bytes differ from the source', async () => {
    const source = await createSourcePlugin({ id: 'nexus', version: '9.9.9' });
    const installed = await createInstalledPlugin(
      source,
      { id: 'nexus', version: '9.9.9' },
      'installed bundle\n'
    );
    temporaryDirectories.push(source, installed);

    const result = runVerifier(source, installed);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ bundleParity: false });
    expect(result.stderr).toContain('source and installed main.js SHA-256 differ');
  });
});
