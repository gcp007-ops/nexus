/**
 * Where the VFS cache file lands, on each platform.
 *
 * The environment is injected rather than read, because the interesting
 * assertion — that the Windows branch produces a Windows path — is otherwise
 * unmakeable from a Mac, and this is exactly the code that has no second chance
 * to be right: a wrong root either puts a 99 MB file inside a synced folder or
 * fails to open at all.
 */

import {
  resolveAppDataRoot,
  resolveCacheFileLocation,
  sanitiseVaultKey
} from '../../src/database/storage/vfs/cacheFileLocation';

const macOS = { platform: 'darwin', env: {}, homedir: () => '/Users/someone' };
const windows = { platform: 'win32', env: {}, homedir: () => 'C:\\Users\\someone' };
const linux = { platform: 'linux', env: {}, homedir: () => '/home/someone' };

describe('resolveAppDataRoot', () => {
  it('uses Application Support on macOS', () => {
    expect(resolveAppDataRoot(macOS))
      .toBe('/Users/someone/Library/Application Support/nexus-cache');
  });

  it('uses LOCALAPPDATA on Windows when it is set', () => {
    expect(resolveAppDataRoot({ ...windows, env: { LOCALAPPDATA: 'D:\\AppData' } }))
      .toBe('D:\\AppData\\nexus-cache');
  });

  it('falls back to the conventional Local path when LOCALAPPDATA is absent', () => {
    expect(resolveAppDataRoot(windows))
      .toBe('C:\\Users\\someone\\AppData\\Local\\nexus-cache');
  });

  it('honours XDG_DATA_HOME on Linux', () => {
    expect(resolveAppDataRoot({ ...linux, env: { XDG_DATA_HOME: '/data/xdg' } }))
      .toBe('/data/xdg/nexus-cache');
  });

  it('falls back to ~/.local/share on Linux', () => {
    expect(resolveAppDataRoot(linux)).toBe('/home/someone/.local/share/nexus-cache');
  });

  it('treats an empty override as absent rather than as a root', () => {
    expect(resolveAppDataRoot({ ...linux, env: { XDG_DATA_HOME: '' } }))
      .toBe('/home/someone/.local/share/nexus-cache');
  });
});

describe('sanitiseVaultKey', () => {
  it('replaces the colon computeIdbKey produces, which Windows rejects', () => {
    expect(sanitiseVaultKey('abc123:nexus')).toBe('abc123-nexus');
  });

  it('collapses runs of replaced characters instead of stacking separators', () => {
    expect(sanitiseVaultKey('a//::b')).toBe('a-b');
  });

  it('keeps a key that is already safe untouched', () => {
    expect(sanitiseVaultKey('path-1a2b3c4d.nexus_v2')).toBe('path-1a2b3c4d.nexus_v2');
  });

  it('never returns an empty segment, which would put the file in the root', () => {
    expect(sanitiseVaultKey('///')).toBe('unknown-vault');
  });
});

describe('resolveCacheFileLocation', () => {
  it('separates the per-vault directory from the file inside it', () => {
    const location = resolveCacheFileLocation('abc123:nexus', macOS);
    expect(location.dir)
      .toBe('/Users/someone/Library/Application Support/nexus-cache/abc123-nexus');
    expect(location.file).toBe(`${location.dir}/cache.db`);
  });

  it('uses backslashes on Windows', () => {
    const location = resolveCacheFileLocation('abc123:nexus', windows);
    expect(location.file)
      .toBe('C:\\Users\\someone\\AppData\\Local\\nexus-cache\\abc123-nexus\\cache.db');
  });

  it('gives two vaults two directories', () => {
    const first = resolveCacheFileLocation('vault-one:nexus', macOS);
    const second = resolveCacheFileLocation('vault-two:nexus', macOS);
    expect(first.file).not.toBe(second.file);
  });
});
