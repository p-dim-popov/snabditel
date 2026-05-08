import type { InjectionScope, Resolvable, Resolved, SnabditelType, Token } from "./snabditel.types";

export function createToken<T>(name: string): Token<T> {
  return name as Token<T>;
}

type ChainHit = { hit: true; value: unknown } | { hit: false };

const ASYNC_DISPOSE = (Symbol as { asyncDispose?: symbol }).asyncDispose;
const SYNC_DISPOSE = (Symbol as { dispose?: symbol }).dispose;

export class Snabditel implements SnabditelType {
  private readonly parent: Snabditel | undefined;
  private readonly cache = new Map<unknown, unknown>();
  private readonly pending = new Map<unknown, Promise<unknown>>();
  private readonly root_: Snabditel;
  private disposed = false;

  constructor(parent?: Snabditel) {
    this.parent = parent;
    this.root_ = parent ? parent.root_ : this;
  }

  seed(key: unknown, instance: unknown): this {
    this.cache.set(key, instance);
    this.pending.delete(key);
    return this;
  }

  async resolve(key: unknown): Promise<unknown> {
    if (this.disposed) throw new Error('Cannot resolve on a disposed Snabditel scope.');

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

    const target: Snabditel = lifetime === 'singleton' ? this.root_ : this;
    const promise = Promise.resolve().then(() => cls.getInstance(this));
    target.pending.set(key, promise);
    try {
      const value = await promise;
      if (target.cache.has(key)) return target.cache.get(key);
      target.cache.set(key, value);
      return value;
    } finally {
      target.pending.delete(key);
    }
  }

  async run<T>(fn: (scope: Snabditel) => Promise<T> | T): Promise<T> {
    const child = new Snabditel(this);
    let fnError: { e: unknown } | undefined;
    let result: T | undefined;
    try {
      result = await fn(child);
    } catch (e) {
      fnError = { e };
    }
    try {
      await child.dispose();
    } catch (disposeErr) {
      if (!fnError) throw disposeErr;
    }
    if (fnError) throw fnError.e;
    return result as T;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const v of this.cache.values()) {
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) continue;
      const d = v as Record<symbol, unknown>;
      try {
        if (ASYNC_DISPOSE && typeof d[ASYNC_DISPOSE] === 'function') {
          await (d[ASYNC_DISPOSE] as () => Promise<void> | void).call(d);
        } else if (SYNC_DISPOSE && typeof d[SYNC_DISPOSE] === 'function') {
          (d[SYNC_DISPOSE] as () => void).call(d);
        }
      } catch (e) {
        errors.push(e);
      }
    }
    this.cache.clear();
    this.pending.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Errors during Snabditel.dispose');
  }

  #findInChain(key: unknown): ChainHit {
    let s: Snabditel | undefined = this;
    while (s) {
      if (s.cache.has(key)) return { hit: true, value: s.cache.get(key) };
      const pending = s.pending.get(key);
      if (pending) return { hit: true, value: pending };
      s = s.parent;
    }
    return { hit: false };
  }
}
