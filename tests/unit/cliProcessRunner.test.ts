import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { runCliProcess } from '../../src/utils/cliProcessRunner';

jest.mock('../../src/utils/desktopProcess', () => ({
  spawnDesktopProcess: jest.fn()
}));

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
}

describe('runCliProcess', () => {
  const { spawnDesktopProcess } = jest.requireMock('../../src/utils/desktopProcess') as {
    spawnDesktopProcess: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves existing no-stdin behavior for CLI callers', async () => {
    const child = createMockChildProcess();

    spawnDesktopProcess.mockImplementation((_childProcess, _command, _args, options) => {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

      process.nextTick(() => {
        child.stdout.write('stdout text');
        child.stderr.write('stderr text');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });

      return child;
    });

    const handle = runCliProcess('/mock/bin/claude', ['auth', 'status'], {
      cwd: '/mock/vault'
    });

    await expect(handle.result).resolves.toEqual({
      stdout: 'stdout text',
      stderr: 'stderr text',
      exitCode: 0
    });
  });

  it('writes stdin text and switches to piped stdin when requested', async () => {
    const child = createMockChildProcess();
    const stdinChunks: string[] = [];

    child.stdin.on('data', (chunk: Buffer | string) => {
      stdinChunks.push(chunk.toString());
    });

    spawnDesktopProcess.mockImplementation((_childProcess, _command, _args, options) => {
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);

      process.nextTick(() => {
        child.stdout.write('{"response":"ok"}');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });

      return child;
    });

    const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
      cwd: '/mock/vault',
      stdinText: 'Prompt from stdin'
    });

    await expect(handle.result).resolves.toEqual({
      stdout: '{"response":"ok"}',
      stderr: '',
      exitCode: 0
    });
    expect(stdinChunks.join('')).toBe('Prompt from stdin');
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('captures spawn error codes for adapter-specific mapping', async () => {
    const child = createMockChildProcess();

    spawnDesktopProcess.mockReturnValue(child);

    const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
      cwd: '/mock/vault',
      stdinText: 'Prompt from stdin'
    });

    process.nextTick(() => {
      child.emit('error', Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }));
    });

    await expect(handle.result).resolves.toEqual({
      stdout: '',
      stderr: 'spawn E2BIG',
      exitCode: null,
      errorCode: 'E2BIG'
    });
  });

  it('kills the CLI process when timeoutMs elapses', async () => {
    jest.useFakeTimers();
    const child = createMockChildProcess();

    spawnDesktopProcess.mockReturnValue(child);

    const handle = runCliProcess('/mock/bin/agy', ['--print'], {
      cwd: '/mock/vault',
      timeoutMs: 50
    });

    jest.advanceTimersByTime(50);

    await expect(handle.result).resolves.toEqual({
      stdout: '',
      stderr: 'CLI process timed out after 50ms.',
      exitCode: null,
      errorCode: 'ETIMEDOUT'
    });
    expect(child.kill).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
