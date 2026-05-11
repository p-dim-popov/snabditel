import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  SelfResolvable,
  Token,
} from "./snabditel.types";

type Key = unknown;
type Scope = Map<Key, unknown>;

export type ScopeRecord = {
  cache: Scope;
  disposables: Array<unknown>;
};

export type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
  parent: Frame | null;
};

export type Ctx = {
  scope: ScopeRecord | null;
  frame: Frame | null;
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: ScopeRecord | null;
};

const RANK: Record<InjectionScope, number> = {
  transient: 0,
  scoped: 1,
  singleton: 2,
};

export const EMPTY_CTX: Ctx = Object.freeze({
  scope: null,
  frame: null,
}) as Ctx;

export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private inflight = new Map<Key, Promise<BuildResult<unknown>>>();

  protected outerCtx(): Ctx {
    return EMPTY_CTX;
  }

  protected wrapAsync<T>(_ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  resolve<T>(token: Token<T>): Promise<T> {
    return this.resolveIn(token, this.outerCtx());
  }

  async run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> {
    const outer = this.outerCtx();
    const record: ScopeRecord = { cache: new Map(), disposables: [] };
    const ctx: Ctx = { scope: record, frame: outer.frame };
    return this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
  }

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    return this.seedInto(this.outerCtx().scope, token, value, options);
  }

  private seedInto<T>(
    scope: ScopeRecord | null,
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions,
  ): void {
    const which = options.injectionScope ?? "singleton";
    if (which === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (which === "scoped") {
      if (!scope) throw new Error("Scoped seed requires an active run() scope");
      scope.cache.set(token, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  protected resolveIn<T>(token: Token<T>, ctx: Ctx): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      return this.readSeedAndBubble<T>(token, ctx);
    }

    if (this.singletons.has(token)) {
      this.bubble("singleton", ctx.frame);
      return Promise.resolve(this.singletons.get(token) as T | Promise<T>);
    }

    if (ctx.scope?.cache.has(token)) {
      this.bubble("scoped", ctx.frame);
      return Promise.resolve(ctx.scope.cache.get(token) as T | Promise<T>);
    }

    const pending = this.inflight.get(token);
    if (pending) {
      this.assertNoCycle(token, ctx.frame);
      return this.waiter(token, pending as Promise<BuildResult<T>>, ctx);
    }

    return this.builder(token, ctx);
  }

  private async readSeedAndBubble<T>(
    token: string | symbol,
    ctx: Ctx,
  ): Promise<T> {
    if (ctx.scope?.cache.has(token)) {
      this.bubble("scoped", ctx.frame);
      return (await ctx.scope.cache.get(token)) as T;
    }
    if (this.singletons.has(token)) {
      this.bubble("singleton", ctx.frame);
      return (await this.singletons.get(token)) as T;
    }
    throw new Error(
      `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
    );
  }

  private makeScoped(ctx: Ctx): ASnabditel {
    return {
      resolve: <T>(token: Token<T>): Promise<T> =>
        this.resolveIn(token, ctx),

      seed: <T>(
        token: string | symbol | (new (...args: any[]) => T),
        value: T,
        options: SeedOptions = {},
      ): void => {
        return this.seedInto(ctx.scope, token, value, options);
      },

      run: <T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> => {
        const record: ScopeRecord = { cache: new Map(), disposables: [] };
        const child: Ctx = { scope: record, frame: ctx.frame };
        return this.wrapAsync(child, () => cb(this.makeScoped(child)));
      },
    };
  }

  private async builder<T>(token: Resolvable<T>, ctx: Ctx): Promise<T> {
    this.assertNoCycle(token, ctx.frame);

    const declared = this.scopeOf(token);
    const frame: Frame = {
      ownerToken: token,
      declared,
      minScope: "singleton",
      parent: ctx.frame,
    };

    let resolveSettled!: (r: BuildResult<T>) => void;
    let rejectSettled!: (e: unknown) => void;
    const pending = new Promise<BuildResult<T>>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    pending.catch(() => undefined);
    this.inflight.set(token, pending as Promise<BuildResult<unknown>>);

    try {
      const childCtx: Ctx = { scope: ctx.scope, frame };
      const childS = this.makeScoped(childCtx);
      const value = await this.wrapAsync(childCtx, () =>
        this.build(token, childS),
      );

      if (declared !== undefined && this.isWider(declared, frame.minScope)) {
        throw this.mismatchError(token, declared, frame.minScope);
      }
      const effective: InjectionScope = declared ?? frame.minScope;
      const builtInScope = ctx.scope;

      this.placeIntoCache(token, value, effective, builtInScope, declared);
      this.bubble(effective, ctx.frame);

      const result: BuildResult<T> = {
        value,
        effectiveScope: effective,
        builtInScope,
      };
      resolveSettled(result);
      return value;
    } catch (e) {
      rejectSettled(e);
      throw e;
    } finally {
      this.inflight.delete(token);
    }
  }

  private async waiter<T>(
    token: Resolvable<T>,
    pending: Promise<BuildResult<T>>,
    ctx: Ctx,
  ): Promise<T> {
    const result = await pending;
    this.bubble(result.effectiveScope, ctx.frame);

    if (result.effectiveScope === "singleton") return result.value;
    if (result.effectiveScope === "scoped") {
      if (ctx.scope === result.builtInScope) return result.value;
      return this.resolveIn(token, ctx);
    }
    return this.resolveIn(token, ctx);
  }

  private async build<T>(
    token: Resolvable<T>,
    s: ASnabditel,
  ): Promise<T> {
    if ("createInstance" in token) {
      return await token.createInstance(s);
    }
    return new (token as new () => T)();
  }

  private placeIntoCache<T>(
    token: Resolvable<T>,
    value: T,
    effective: InjectionScope,
    builtInScope: ScopeRecord | null,
    declared: InjectionScope | undefined,
  ): void {
    if (effective === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (effective === "scoped") {
      if (builtInScope === null) {
        throw declared === undefined
          ? this.effectiveScopedNoRunError(token)
          : new Error("Scoped resolution requires an active run() scope");
      }
      builtInScope.cache.set(token, value);
      return;
    }
    // transient: no cache
  }

  private narrower(a: InjectionScope, b: InjectionScope): InjectionScope {
    return RANK[a] <= RANK[b] ? a : b;
  }

  private isWider(declared: InjectionScope, min: InjectionScope): boolean {
    return RANK[declared] > RANK[min];
  }

  private scopeOf<T>(binding: Resolvable<T>): InjectionScope | undefined {
    if ("injectionScope" in binding && binding.injectionScope !== undefined) {
      return binding.injectionScope;
    }
    return undefined;
  }

  private ownerName<T>(binding: Resolvable<T>): string {
    if (typeof binding === "function") {
      return binding.name && binding.name.length > 0
        ? binding.name
        : "anonymous class";
    }
    const ctor = (binding as SelfResolvable<T>).constructor;
    if (ctor && ctor.name && ctor.name !== "Object") return ctor.name;
    return "anonymous SelfResolvable";
  }

  private bubble(scope: InjectionScope, frame: Frame | null): void {
    if (!frame) return;
    const next = this.narrower(frame.minScope, scope);
    if (next === frame.minScope) return;
    frame.minScope = next;
    if (
      frame.declared !== undefined &&
      this.isWider(frame.declared, frame.minScope)
    ) {
      throw this.mismatchError(frame.ownerToken, frame.declared, frame.minScope);
    }
  }

  private assertNoCycle(
    token: Resolvable<unknown>,
    startFrame: Frame | null,
  ): void {
    for (let f: Frame | null = startFrame; f !== null; f = f.parent) {
      if (f.ownerToken === token) {
        throw new Error("Cycle detected during resolution");
      }
    }
  }

  private mismatchError<T>(
    binding: Resolvable<T>,
    declared: InjectionScope,
    min: InjectionScope,
  ): Error {
    return new Error(
      `Cannot resolve ${this.ownerName(binding)} as ${declared}: depends on a ${min} service. ` +
        `Either remove \`injectionScope\` to inherit '${min}', or set it to '${min}' or 'transient'.`,
    );
  }

  private effectiveScopedNoRunError<T>(binding: Resolvable<T>): Error {
    return new Error(
      `${this.ownerName(binding)} effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.`,
    );
  }
}
