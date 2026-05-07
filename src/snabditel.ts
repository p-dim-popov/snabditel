export type InjectionScope = 'singleton' | 'scoped' | 'transient';

export type Resolvable<T = unknown> = {
  getInstance(snabditel: Snabditel): Promise<T> | T;
  injectionScope?: InjectionScope;
};

type Resolved<R extends Resolvable> = Awaited<ReturnType<R['getInstance']>>;

type ChainHit = { hit: true; value: unknown } | { hit: false };

export class Snabditel {
  readonly #parent: Snabditel | undefined;
  readonly #cache = new Map<unknown, unknown>();
  readonly #pending = new Map<unknown, Promise<unknown>>();

  constructor(parent?: Snabditel) {
    this.#parent = parent;
  }

  seed<R extends Resolvable>(key: R, instance: Resolved<R>): this;
  seed<T>(token: string, instance: T): this;
  seed(key: unknown, instance: unknown): this {
    this.#cache.set(key, instance);
    return this;
  }

  resolve<R extends Resolvable>(key: R): Promise<Resolved<R>>;
  resolve<T = unknown>(token: string): Promise<T>;
  async resolve(key: unknown): Promise<unknown> {
    if (typeof key === 'string') {
      const found = this.#findInChain(key);
      if (found.hit) return await found.value;
      throw new Error(`No instance seeded for token: ${key}`);
    }

    const cls = key as Resolvable;

    const found = this.#findInChain(key);
    if (found.hit) return await found.value;

    const lifetime: InjectionScope = cls.injectionScope ?? 'scoped';
    if (lifetime === 'transient') {
      return await cls.getInstance(this);
    }

    const target: Snabditel = lifetime === 'singleton' ? this.#root() : this;
    const promise = Promise.resolve().then(() => cls.getInstance(this));
    target.#pending.set(key, promise);
    try {
      const value = await promise;
      target.#cache.set(key, value);
      return value;
    } finally {
      target.#pending.delete(key);
    }
  }

  async run<T>(fn: (scope: Snabditel) => Promise<T> | T): Promise<T> {
    const child = new Snabditel(this);
    return await fn(child);
  }

  #findInChain(key: unknown): ChainHit {
    let s: Snabditel | undefined = this;
    while (s) {
      if (s.#cache.has(key)) return { hit: true, value: s.#cache.get(key) };
      const pending = s.#pending.get(key);
      if (pending) return { hit: true, value: pending };
      s = s.#parent;
    }
    return { hit: false };
  }

  #root(): Snabditel {
    let s: Snabditel = this;
    while (s.#parent) s = s.#parent;
    return s;
  }
}
