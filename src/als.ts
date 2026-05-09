import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";
import { readSeedToken, writeSeed } from "./internal/seed-helpers";
import {
  effectiveScopedNoRunError,
  isWider,
  mismatchError,
  narrower,
  scopeOf,
} from "./internal/scope-helpers";

type Key = unknown;
type Scope = Map<Key, unknown>;

type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
  parent: Frame | null;
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: Scope | null;
};

export class AlsSnabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private scopeAls = new AsyncLocalStorage<Scope>();
  private frameAls = new AsyncLocalStorage<Frame>();
  private inFlight = new Map<Key, Promise<BuildResult<unknown>>>();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    return this.scopeAls.run(new Map(), callback);
  }

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    writeSeed(this.singletons, () => this.scopeAls.getStore() ?? null, token, value, options);
  }

  private bubble(scope: InjectionScope): void {
    const frame = this.frameAls.getStore();
    if (!frame) return;
    const next = narrower(frame.minScope, scope);
    if (next === frame.minScope) return;
    frame.minScope = next;
    if (frame.declared !== undefined && isWider(frame.declared, frame.minScope)) {
      throw mismatchError(frame.ownerToken, frame.declared, frame.minScope);
    }
  }

  private async build<T>(token: Resolvable<T>): Promise<T> {
    if ("createInstance" in token) {
      return await token.createInstance();
    }
    return new (token as new () => T)();
  }

  private assertNoCycle(token: Resolvable<unknown>, startFrame: Frame | null): void {
    for (let f: Frame | null = startFrame; f !== null; f = f.parent) {
      if (f.ownerToken === token) {
        throw new Error("Cycle detected during resolution");
      }
    }
  }

  private async builder<T>(token: Resolvable<T>): Promise<T> {
    const parent = this.frameAls.getStore() ?? null;
    this.assertNoCycle(token, parent);

    const declared = scopeOf(token);
    const frame: Frame = {
      ownerToken: token,
      declared,
      minScope: "singleton",
      parent,
    };

    let resolveSettled!: (r: BuildResult<T>) => void;
    let rejectSettled!: (e: unknown) => void;
    const pending = new Promise<BuildResult<T>>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    // Suppress unhandled-rejection when no waiter subscribes to this in-flight promise.
    pending.catch(() => undefined);
    this.inFlight.set(token, pending as Promise<BuildResult<unknown>>);

    try {
      const value = await this.frameAls.run(frame, () => this.build(token));

      if (declared !== undefined && isWider(declared, frame.minScope)) {
        throw mismatchError(token, declared, frame.minScope);
      }
      const effective: InjectionScope = declared ?? frame.minScope;
      const builtInScope = this.scopeAls.getStore() ?? null;

      this.placeIntoCache(token, value, effective, builtInScope, declared);
      this.bubble(effective);

      const result: BuildResult<T> = { value, effectiveScope: effective, builtInScope };
      resolveSettled(result);
      return value;
    } catch (e) {
      rejectSettled(e);
      throw e;
    } finally {
      this.inFlight.delete(token);
    }
  }

  private placeIntoCache<T>(
    token: Resolvable<T>,
    value: T,
    effective: InjectionScope,
    builtInScope: Scope | null,
    declared: InjectionScope | undefined,
  ): void {
    if (effective === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (effective === "scoped") {
      if (builtInScope === null) {
        throw declared === undefined
          ? effectiveScopedNoRunError(token)
          : new Error("Scoped resolution requires an active run() scope");
      }
      builtInScope.set(token, value);
      return;
    }
    // transient: no cache
  }

  async resolve<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      const scope = this.scopeAls.getStore() ?? null;
      const result = await readSeedToken<T>(this.singletons, scope, token);
      this.bubble(result.source);
      return result.value;
    }

    if (this.singletons.has(token)) {
      this.bubble("singleton");
      return (await this.singletons.get(token)) as T;
    }

    const currentScope = this.scopeAls.getStore() ?? null;
    if (currentScope?.has(token)) {
      this.bubble("scoped");
      return (await currentScope.get(token)) as T;
    }

    const pending = this.inFlight.get(token);
    if (pending) {
      this.assertNoCycle(token, this.frameAls.getStore() ?? null);
      return this.waiter(token, pending as Promise<BuildResult<T>>);
    }

    return this.builder(token);
  }

  private async waiter<T>(
    token: Resolvable<T>,
    pending: Promise<BuildResult<T>>,
  ): Promise<T> {
    const result = await pending;
    this.bubble(result.effectiveScope);

    if (result.effectiveScope === "singleton") {
      return result.value;
    }
    if (result.effectiveScope === "scoped") {
      if ((this.scopeAls.getStore() ?? null) === result.builtInScope) {
        return result.value;
      }
      return this.resolve(token);          // restart in our run
    }
    // transient
    return this.resolve(token);
  }
}
