/** A7: orphan authority locks left by a quit/crash are recovered only when the
 * owner is provably gone (same host and dead PID, or a live PID with another
 * start instant). Every doubt keeps the refusal. Real files under TMPDIR; only
 * the process probe is emulated. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskAuthorityDurableJournal, createProcessProbe, type LockProcessProbe, type ProcessReader } from '../../src/database/storage/TaskAuthorityDurableJournal';

const HOST = 'host-a';
const OUR_START = 'Sat Nov 21 02:00:00 2026';
function probe(dead: number[] = [], starts: Record<number, string> = {}): LockProcessProbe {
  return {
    hostname: () => HOST,
    alive: pid => !dead.includes(pid),
    startTime: async pid => pid === process.pid ? OUR_START : (starts[pid] ?? null)
  };
}
function layout() {
  Object.defineProperty(globalThis, 'window', { value: { require }, configurable: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-lock-')));
  const authorityRoot = path.join(root, 'task-authority');
  const directory = path.join(authorityRoot, 'a'.repeat(64));
  fs.mkdirSync(directory, { recursive: true });
  const writerLock = path.join(root, 'task-authority-writer.lock');
  const ownerLock = path.join(directory, 'owner.lock');
  const orphan = (pid: number, extra: Record<string, unknown> = { hostname: HOST, startedAt: 'old' }) => {
    const body = JSON.stringify({ protocol: 'task-authority-owner/v1', token: 'b'.repeat(64), pid, ...extra });
    fs.writeFileSync(writerLock, body); fs.writeFileSync(ownerLock, body);
  };
  return { root, directory, writerLock, ownerLock, orphan, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const DEAD = 999999;

describe('A7 — recuperação de trava órfã da autoridade', () => {
  it('recupera a trava de PID morto no mesmo host e ativa', async () => {
    const l = layout(); try {
      l.orphan(DEAD);
      const journal = new TaskAuthorityDurableJournal(l.directory, probe([DEAD]));
      await journal.activate(); await journal.assertActive();
      const owner = JSON.parse(fs.readFileSync(l.writerLock, 'utf8')) as Record<string, unknown>;
      expect(owner).toMatchObject({ pid: process.pid, hostname: HOST, startedAt: OUR_START });
      expect(JSON.parse(fs.readFileSync(l.ownerLock, 'utf8'))).toMatchObject({ token: owner.token, pid: process.pid });
      expect(fs.readdirSync(l.root).filter(name => name.includes('.recovery') || name.endsWith('.tmp'))).toEqual([]);
      await journal.deactivate();
      expect(fs.existsSync(l.writerLock)).toBe(false); expect(fs.existsSync(l.ownerLock)).toBe(false);
    } finally { l.cleanup(); }
  });
  it('mantém a recusa (EEXIST) com PID vivo e mesmo instante de início', async () => {
    const l = layout(); try {
      l.orphan(4242, { hostname: HOST, startedAt: 'same' });
      const before = fs.readFileSync(l.writerLock, 'utf8');
      await expect(new TaskAuthorityDurableJournal(l.directory, probe([], { 4242: 'same' })).activate()).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fs.readFileSync(l.writerLock, 'utf8')).toBe(before); expect(fs.readFileSync(l.ownerLock, 'utf8')).toBe(before);
    } finally { l.cleanup(); }
  });
  it('recusa trava de outro host, mesmo com o PID ausente aqui', async () => {
    const l = layout(); try {
      l.orphan(DEAD, { hostname: 'host-b', startedAt: 'old' });
      const before = fs.readFileSync(l.writerLock, 'utf8');
      await expect(new TaskAuthorityDurableJournal(l.directory, probe([DEAD])).activate()).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fs.readFileSync(l.writerLock, 'utf8')).toBe(before);
    } finally { l.cleanup(); }
  });
  it('recupera a trava de PID reusado (vivo, com outro instante de início)', async () => {
    const l = layout(); try {
      l.orphan(4242, { hostname: HOST, startedAt: 'Fri Nov 20 09:00:00 2026' });
      const journal = new TaskAuthorityDurableJournal(l.directory, probe([], { 4242: 'Sat Nov 21 01:00:00 2026' }));
      await journal.activate(); await journal.assertActive();
      expect(JSON.parse(fs.readFileSync(l.writerLock, 'utf8'))).toMatchObject({ pid: process.pid });
    } finally { l.cleanup(); }
  });
  it('recusa PID vivo quando o instante de início não pode ser lido', async () => {
    const l = layout(); try {
      l.orphan(4242, { hostname: HOST, startedAt: 'old' });
      await expect(new TaskAuthorityDurableJournal(l.directory, probe()).activate()).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { l.cleanup(); }
  });
  it('recusa trava antiga sem hostname: o mesmo host não é provável', async () => {
    const l = layout(); try {
      l.orphan(DEAD, {});
      await expect(new TaskAuthorityDurableJournal(l.directory, probe([DEAD])).activate()).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { l.cleanup(); }
  });
  it('corrida entre duas ativações sobre a mesma trava órfã: só uma vence', async () => {
    const l = layout(); try {
      l.orphan(DEAD);
      const other = path.join(path.dirname(l.directory), 'c'.repeat(64)); fs.mkdirSync(other);
      const journals = [new TaskAuthorityDurableJournal(l.directory, probe([DEAD])), new TaskAuthorityDurableJournal(other, probe([DEAD]))];
      const results = await Promise.allSettled(journals.map(journal => journal.activate()));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const winner = journals[results.findIndex(result => result.status === 'fulfilled')];
      await winner.assertActive();
      const owners = [l.ownerLock, path.join(other, 'owner.lock')].filter(file => fs.existsSync(file));
      expect(owners).toHaveLength(1);
    } finally { l.cleanup(); }
  });
});

describe('A7 I-1 — instante de início do processo por plataforma', () => {
  const BOOT = '3f1c2a9e-0000-4000-8000-000000000001';
  // comm com espaço e parêntese, como o kernel permite; o campo 22 é o starttime.
  const stat = (pid: number, ticks: number) => `${pid} (Obsidian (Ren) x) S ${Array.from({ length: 18 }, (_, i) => i + 4).join(' ')} ${ticks} 0 0`;
  function linuxReader(ticks: Record<number, number>, lstart: Record<number, string> = {}): ProcessReader {
    return {
      platform: 'linux', hostname: () => HOST,
      kill: pid => { if (!(pid in ticks)) { const error = new Error('ESRCH') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; } },
      readFile: file => {
        if (file === '/proc/sys/kernel/random/boot_id') return BOOT + '\n';
        const match = /^\/proc\/(\d+)\/stat$/.exec(file);
        if (match && Number(match[1]) in ticks) return stat(Number(match[1]), ticks[Number(match[1])]);
        throw new Error('ENOENT ' + file);
      },
      ps: async pid => lstart[pid] ?? null
    };
  }
  it('no Linux usa /proc/<pid>/stat (campo 22) com boot_id, e não o lstart do ps', async () => {
    const probe = createProcessProbe(linuxReader({ 4242: 123456 }, { 4242: 'Sat Nov 21 02:00:00 2026' }));
    expect(await probe.startTime(4242)).toBe(`linux:${BOOT}:123456`);
  });
  it('no Linux, ajuste de relógio (lstart muda, starttime não) não libera a trava de dono vivo', async () => {
    const l = layout(); try {
      const before = createProcessProbe(linuxReader({ 4242: 123456, [process.pid]: 777 }, { 4242: 'Sat Nov 21 02:00:00 2026' }));
      l.orphan(4242, { hostname: HOST, startedAt: await before.startTime(4242) });
      // Relógio adiantado 5 s: o ps mudaria, o /proc não.
      const after = createProcessProbe(linuxReader({ 4242: 123456, [process.pid]: 777 }, { 4242: 'Sat Nov 21 02:00:05 2026' }));
      await expect(new TaskAuthorityDurableJournal(l.directory, after).activate()).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { l.cleanup(); }
  });
  it('no Linux, PID reusado (outro starttime) é recuperado', async () => {
    const l = layout(); try {
      l.orphan(4242, { hostname: HOST, startedAt: `linux:${BOOT}:111` });
      const journal = new TaskAuthorityDurableJournal(l.directory, createProcessProbe(linuxReader({ 4242: 222, [process.pid]: 777 })));
      await journal.activate(); await journal.assertActive();
      expect(JSON.parse(fs.readFileSync(l.writerLock, 'utf8'))).toMatchObject({ pid: process.pid, startedAt: `linux:${BOOT}:777` });
    } finally { l.cleanup(); }
  });
  it('no Linux sem /proc legível, PID vivo nunca é recuperado', async () => {
    const l = layout(); try {
      l.orphan(4242, { hostname: HOST, startedAt: `linux:${BOOT}:111` });
      const reader = { ...linuxReader({ 4242: 222, [process.pid]: 777 }), readFile: () => { throw new Error('EACCES'); } };
      await expect(new TaskAuthorityDurableJournal(l.directory, createProcessProbe(reader)).activate()).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { l.cleanup(); }
  });
  it('no macOS mantém o lstart do ps; em outra plataforma não há instante', async () => {
    const mac = createProcessProbe({ ...linuxReader({ 4242: 1 }, { 4242: 'Sat Nov 21 02:00:00 2026' }), platform: 'darwin' });
    expect(await mac.startTime(4242)).toBe('Sat Nov 21 02:00:00 2026');
    const win = createProcessProbe({ ...linuxReader({ 4242: 1 }, { 4242: 'x' }), platform: 'win32' });
    expect(await win.startTime(4242)).toBeNull();
  });
  it('Minor 5: trava vazia (crash entre wx e writeFile) continua recusada', async () => {
    const l = layout(); try {
      fs.writeFileSync(l.writerLock, '');
      await expect(new TaskAuthorityDurableJournal(l.directory, probe([DEAD])).activate()).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fs.readFileSync(l.writerLock, 'utf8')).toBe('');
    } finally { l.cleanup(); }
  });
});
