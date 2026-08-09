export class WorkflowRunConflictError extends Error {
  constructor(
    readonly reason: 'reserved' | 'persisted',
    readonly runKey: string
  ) {
    super(reason === 'reserved'
      ? `Workflow run is already reserved: ${runKey}`
      : `Workflow run already exists: ${runKey}`);
    this.name = 'WorkflowRunConflictError';
  }
}

export class WorkflowRunReservationService {
  private readonly reservedRunKeys = new Set<string>();

  async runExclusive<T>(runKey: string, action: () => Promise<T>): Promise<T> {
    if (this.reservedRunKeys.has(runKey)) {
      throw new WorkflowRunConflictError('reserved', runKey);
    }

    this.reservedRunKeys.add(runKey);
    try {
      return await action();
    } finally {
      this.reservedRunKeys.delete(runKey);
    }
  }
}
