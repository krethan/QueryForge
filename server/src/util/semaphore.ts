import { AppError } from './errors.js';

/** Bounded concurrency gate with an optional wait queue limit. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue = max * 4,
  ) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    if (this.queue.length >= this.maxQueue) {
      throw new AppError(
        429,
        'TOO_MANY_EXECUTIONS',
        'Too many concurrent query executions. Try again shortly.',
      );
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}
