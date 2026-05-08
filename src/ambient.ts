import { AsyncLocalStorage } from 'node:async_hooks';
import { type SnabditelType, type Resolvable, type Resolved, type Token } from './snabditel.types.js';
import { Snabditel } from './snabditel.js';

export class AmbientSnabditel implements SnabditelType {
  private readonly root: SnabditelType;
  private readonly als = new AsyncLocalStorage<SnabditelType>();

  constructor(root: SnabditelType = new Snabditel()) {
    this.root = root;
  }

  current(): SnabditelType {
    const s = this.als.getStore();
    if (!s) {
      throw new Error('No ambient Snabditel scope. Wrap calls in ambient.run(fn).');
    }
    return s;
  }

  tryCurrent(): SnabditelType | undefined {
    return this.als.getStore();
  }

  seed(key: unknown, instance: unknown): this {
    (this.current() as unknown as { seed: (k: unknown, v: unknown) => void }).seed(key, instance);
    return this;
  }

  resolve(key: unknown): Promise<unknown> {
    return (this.current() as unknown as { resolve: (k: unknown) => Promise<unknown> }).resolve(key);
  }

  async run<T>(fn: (scope: SnabditelType) => Promise<T> | T): Promise<T> {
    const parent = this.als.getStore() ?? this.root;
    return parent.run((child) => this.als.run(child, () => fn(child)));
  }

  async dispose(): Promise<void> {
    return this.root.dispose();
  }
}
