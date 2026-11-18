import { serializeAuthority } from '../../src/agents/taskManager/services/TaskCoordinationService';

describe('authority shared serializer', () => {
  it('prevents two service instances from acquiring the same resource', async () => {
    let owner: string | undefined;
    const legacy = async (id: string): Promise<boolean> => {
      if (owner) return false;
      await Promise.resolve();
      owner = id;
      return true;
    };
    expect(await Promise.all([legacy('one'), legacy('two')])).toEqual([true, true]);
    owner = undefined;
    const first = () => serializeAuthority('vault', 'authority', () => legacy('one'));
    const second = () => serializeAuthority('vault', 'authority', () => legacy('two'));
    expect(await Promise.all([first(), second()])).toEqual([true, false]);
  });
  it('does not strand the queue after a failure', async () => {
    await expect(serializeAuthority('vault', 'authority', async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    await expect(serializeAuthority('vault', 'authority', async () => 42)).resolves.toBe(42);
  });
});
