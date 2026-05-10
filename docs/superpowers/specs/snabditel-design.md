# Snabditel — design

A small, browser-safe DI container with explicit `run()` scopes, scope inheritance, and lifetime validation. An optional `node:async_hooks` adapter layers implicit propagation on top.

## Motivation

DI containers in JS typically pick one of:

1. **Module-level singletons** with a single `run()` scope active at a time — simple, but rules out parallel scopes (e.g. concurrent SSR requests, parallel React Query fetches).
2. **`AsyncLocalStorage`** propagation — concurrency-safe but node-only.
3. **Implicit reactive context** (Zone.js, React Context) — framework-coupled.

Snabditel takes a fourth path: the active scope is an explicit by-value `Resolver` (`s`) handed to `run()` callbacks and to `createInstance(s)`. The base container is browser-safe, parallel-run safe, and zero-runtime-dependency. ALS is an optional 14-line subclass for users who want implicit propagation in node.

## Goals

1. **Parallel `run()` scopes** — `Promise.all([di.run(...), di.run(...)])` works in any JS runtime, no polyfills.
2. **Browser-safe core** — `src/snabditel.ts` does not import `node:async_hooks`.
3. **Scope inheritance** — when `injectionScope` is omitted, a token's effective scope is the narrowest scope of its dependencies.
4. **Lifetime validation** — when `injectionScope` is declared wider than its narrowest dependency, throw a clear error at first resolve.
5. **Single-flight dedupe** — concurrent resolves of the same token share a build.
6. **Cycle detection** — direct and indirect cycles throw rather than deadlock.
7. **Optional ALS adapter** — `AlsSnabditel` adds implicit propagation; existing `await di.resolve(...)` inside `createInstance` keeps working without an `s` arg.

## Non-goals

- `AsyncContext` (TC39) integration. Future opt-in adapter if and when adopted.
- Zone.js, React-Context, or framework-coupled propagation.
- Static (compile-time) lifetime validation. Inference + check happens at first resolve.
- Re-validation after a token is cached.
- Backward compatibility with a no-arg `createInstance(): T` signature. The `s` arg is required by the type.

## Architecture

```
ASnabditel (interface)
├── Snabditel       — closure-based ctx, browser-safe, parallel-run safe.
└── AlsSnabditel    — extends Snabditel; overrides outerCtx() + wrapAsync(ctx, fn)
                      to layer AsyncLocalStorage<Ctx> for implicit propagation.
```

The base owns the engine: scope resolution, inheritance, validation, single-flight dedupe, cycle detection. The ALS adapter is two methods.

The scope-bound resolver `s` passed to `run()` callbacks and to `createInstance(s)` is **not a class**. It's an object literal `{ resolve, seed, run }` produced by a private `makeScoped(ctx)` factory. Closures inside it access `Snabditel`'s private state via captured `this`. Externally typed only as `ASnabditel`.

## Public types

```ts
// snabditel.types.ts

export type InjectionScope = "singleton" | "transient" | "scoped";

export type SelfResolvable<T> = {
  createInstance(s: ASnabditel): T | Promise<T>;
  injectionScope?: InjectionScope;
};

export type NewableResolvable<T> = new () => T;

export type Resolvable<T> = SelfResolvable<T> | NewableResolvable<T>;

export type Token<T> = string | symbol | Resolvable<T>;

export type Resolver = {
  resolve<T>(token: Token<T>): Promise<T>;
};

export type SeedOptions = { injectionScope?: InjectionScope };

export type Seeder = {
  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options?: SeedOptions,
  ): void;
};

export type Scopeable = {
  run<T>(callback: (s: ASnabditel) => Promise<T>): Promise<T>;
};

export type ASnabditel = Resolver & Seeder & Scopeable;
```

`NewableResolvable` is a no-arg ctor — newables are leaves; non-trivial wiring uses `SelfResolvable` and the `s` arg.

## Resolution context

```ts
type Key = unknown;
type Scope = Map<Key, unknown>;

export type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
  parent: Frame | null;
};

export type Ctx = {
  scope: Scope | null;       // null = no run() active
  frame: Frame | null;       // current build chain
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: Scope | null;
};

export const EMPTY_CTX: Ctx = Object.freeze({ scope: null, frame: null });
```

`EMPTY_CTX` is a frozen module-level singleton — `outerCtx()` returns it on the no-active-scope path so we don't allocate a fresh `{ scope: null, frame: null }` every resolve.

`Frame` carries cycle-detection state and the minimum scope observed across this build's deps. `Ctx` is the per-resolution snapshot threaded through `resolveIn`.

## Class layout

```ts
export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private inflight = new Map<Key, Promise<BuildResult<unknown>>>();

  /* Subclass hooks — base = no-ops. */
  protected outerCtx(): Ctx { return EMPTY_CTX; }
  protected wrapAsync<T>(_ctx: Ctx, fn: () => Promise<T>): Promise<T> { return fn(); }

  /* Public surface. */
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token, value, options?): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;

  /* Engine — shared by base + adapter. */
  protected resolveIn<T>(token: Token<T>, ctx: Ctx): Promise<T>;
  private makeScoped(ctx: Ctx): ASnabditel;
  private builder<T>(token, ctx): Promise<T>;
  private waiter<T>(token, pending, ctx): Promise<T>;
  private build<T>(token, s): Promise<T>;
  private placeIntoCache<T>(token, value, effective, builtInScope, declared): void;
  private seedInto<T>(scope: Scope | null, token, value, options): void;
  private readSeedAndBubble<T>(token: string | symbol, ctx: Ctx): Promise<T>;
  private bubble(scope: InjectionScope, frame: Frame | null): void;
  private assertNoCycle(token, startFrame): void;
  private narrower(a, b): InjectionScope;
  private isWider(declared, min): boolean;
  private scopeOf<T>(binding): InjectionScope | undefined;
  private ownerName<T>(binding): string;
  private mismatchError<T>(binding, declared, min): Error;
  private effectiveScopedNoRunError<T>(binding): Error;
}
```

A single root-level `inflight` map is keyed by token. Concurrent resolves across runs see the same in-flight build and dispatch in `waiter` based on the builder's resolved effective scope.

## ALS adapter

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Snabditel, EMPTY_CTX, type Ctx } from "./snabditel";

export class AlsSnabditel extends Snabditel {
  private ctxAls = new AsyncLocalStorage<Ctx>();

  protected override outerCtx(): Ctx {
    return this.ctxAls.getStore() ?? EMPTY_CTX;
  }

  protected override wrapAsync<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return this.ctxAls.run(ctx, fn);
  }
}
```

Two overrides. `outerCtx()` returns the current ALS-stored ctx, so module-level `di.resolve(...)` and `di.seed(...)` see the active scope without explicit `s`. `wrapAsync(ctx, fn)` pushes `ctx` onto ALS for the duration of `fn` — base calls it both around the user callback in `run()` and around every per-build `createInstance`. So `await di.resolve(...)` *inside* `createInstance` (no `s` arg) finds the right frame for inheritance, validation, and cycle detection.

## Resolution flow

### `run(cb)`

```ts
async run<T>(cb): Promise<T> {
  const outer = this.outerCtx();
  const ctx: Ctx = { scope: new Map(), frame: outer.frame };
  return this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
}
```

Fresh scope per `run()` call. Parent's frame chain is inherited so cycle detection survives nested `run()`. `wrapAsync` is the hook ALS uses; in the base it's a pass-through.

### `seed`

```ts
seed(token, value, options) {
  return this.seedInto(this.outerCtx().scope, token, value, options);
}
```

`seedInto` writes `singleton` to `singletons`, `scoped` to the given scope (throws if null), and rejects `transient` outright. The scope-bound `s.seed` reuses `seedInto` with the captured `ctx.scope`.

### `resolveIn(token, ctx)`

```
1. string | symbol         → readSeedAndBubble(token, ctx).
2. singletons.has(token)   → bubble("singleton", ctx.frame); return cached.
3. ctx.scope?.has(token)   → bubble("scoped",    ctx.frame); return cached.
4. inflight.has(token)     → assertNoCycle; waiter(token, pending, ctx).
5. else                    → builder(token, ctx).
```

`readSeedAndBubble` checks `ctx.scope` first, then `singletons`. Scope hit shadows singleton. Miss → `Unknown token: <t>...`.

The cache and seed checks come before the in-flight check intentionally — a same-run waiter for an already-cached scoped token returns from the scope hit branch without entering the waiter dispatch.

### `builder(token, ctx)`

```
1. assertNoCycle(token, ctx.frame).
2. declared = scopeOf(token).
3. frame = { ownerToken: token, declared, minScope: 'singleton', parent: ctx.frame }.
4. Register pending in `inflight`. Suppress unhandled-rejection on it.
5. childCtx = { scope: ctx.scope, frame }; childS = makeScoped(childCtx).
6. value = await wrapAsync(childCtx, () => build(token, childS)).
   - build: SelfResolvable → token.createInstance(childS); newable → new token().
7. Validate: declared !== undefined && isWider(declared, frame.minScope) → mismatchError.
8. effective = declared ?? frame.minScope.
9. placeIntoCache(token, value, effective, ctx.scope, declared).
10. bubble(effective, ctx.frame).
11. Settle pending with { value, effectiveScope, builtInScope: ctx.scope }. Delete from inflight.
12. On reject: pending rejects, inflight cleared in finally — no cache writes, retry-clean.
```

`bubble` runs both during `createInstance` (each nested `s.resolve(...)` reports its dep's effective scope) and once after the build completes (the parent frame learns the child's effective scope). It throws `mismatchError` synchronously the first time the running min crosses the declared boundary, aborting `createInstance` early and avoiding side-effects past the violating dep.

### `waiter(token, pending, ctx)`

```
result = await pending
bubble(result.effectiveScope, ctx.frame)

singleton  → return result.value
scoped     → ctx.scope === result.builtInScope ? return result.value : resolveIn(token, ctx)
transient  → resolveIn(token, ctx)
```

The restart re-enters `resolveIn`. The original builder cleared `inflight` before settling, so the restarter either becomes the new builder or finds a fresh in-flight and waits again — bounded.

### `placeIntoCache(token, value, effective, builtInScope, declared)`

| effective | action |
|---|---|
| singleton | `singletons.set(token, value)` |
| scoped, builtInScope present | `builtInScope.set(token, value)` |
| scoped, builtInScope null, declared undefined | throw `effectiveScopedNoRunError` |
| scoped, builtInScope null, declared = 'scoped' | throw `Scoped resolution requires an active run() scope` |
| transient | no cache write |

### `makeScoped(ctx)`

```ts
return {
  resolve: <T>(token) => this.resolveIn(token, ctx),
  seed:    <T>(token, value, options) => this.seedInto(ctx.scope, token, value, options),
  run:     <T>(cb) => {
    const child: Ctx = { scope: new Map(), frame: ctx.frame };
    return this.wrapAsync(child, () => cb(this.makeScoped(child)));
  },
};
```

Plain object literal. `ctx` is captured by closure; calling `s.resolve(...)` after the outer `run()` settles still works (singletons resolve from the shared cache; scoped tokens see the captured, now-stale scope map).

## Scope rules

Lifetime ordering, narrowest to widest:

```
transient  →  scoped  →  singleton
```

Validity (declared parent scope must be ≤ narrowest dependency scope):

| declared \ dep | transient | scoped | singleton |
|---|---|---|---|
| transient | ok | ok | ok |
| scoped | error | ok | ok |
| singleton | error | error | ok |

Inheritance for unset `injectionScope`:

- No deps → singleton.
- Deps `{singleton}` → singleton.
- Deps `{singleton, scoped}` → scoped.
- Deps `{singleton, transient}` → transient.
- Deps `{scoped, transient}` → transient.

Applies to both `NewableResolvable` (no deps observable; effective stays singleton) and `SelfResolvable`.

### Dependency scope sources

- Class / `SelfResolvable` with explicit `injectionScope` → that value.
- Class / `SelfResolvable` without `injectionScope` → its computed effective scope (recursively, cached on first build).
- String / symbol seed → cache location lookup. Hit in current scope → `scoped`. Hit in `singletons` → `singleton`. Transient seeds remain forbidden.

## Helpers

All private methods on `Snabditel`. No `src/internal/` directory.

```ts
private narrower(a, b)             → InjectionScope     // RANK[a] <= RANK[b] ? a : b
private isWider(declared, min)     → boolean            // RANK[declared] > RANK[min]
private scopeOf<T>(binding)        → InjectionScope|undefined
private ownerName<T>(binding)      → string
private bubble(scope, frame)                            // narrows + early-throws on mismatch
private assertNoCycle(token, startFrame)                // walks parent chain
private mismatchError(binding, declared, min)
private effectiveScopedNoRunError(binding)
```

`RANK` is a module-level const: `{ transient: 0, scoped: 1, singleton: 2 }`.

`ownerName` returns:

- Class (function): `binding.name` if non-empty, else `"anonymous class"`.
- `SelfResolvable` literal: `binding.constructor?.name` if not `"Object"`, else `"anonymous SelfResolvable"`.

## Errors

| Trigger | Message |
|---|---|
| String / symbol token not seeded | `Unknown token: <t>. String and symbol tokens must be seeded before resolution.` |
| Scoped seed outside `run()` | `Scoped seed requires an active run() scope` |
| Transient seed | `Cannot seed a transient value` |
| Declared `scoped` resolved outside `run()` | `Scoped resolution requires an active run() scope` |
| Inferred-`scoped` resolved outside `run()` | `<Owner> effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.` |
| Declared wider than narrowest dep | `` Cannot resolve <Owner> as <declared>: depends on a <min> service. Either remove `injectionScope` to inherit '<min>', or set it to '<min>' or 'transient'. `` |
| Cycle | `Cycle detected during resolution` |

## File layout

```
src/
  snabditel.ts          — Snabditel + engine + helpers; exports Ctx, Frame, EMPTY_CTX for the subclass.
  snabditel.types.ts    — public types (ASnabditel, Resolvable, etc.).
  snabditel.test.ts     — black-box tests for the browser-safe core.
  als.ts                — AlsSnabditel extends Snabditel (14 lines).
  als-index.ts          — subpath entry: re-exports AlsSnabditel.
  als.test.ts           — ALS-specific propagation tests.
  index.ts              — main entry: re-exports Snabditel + types.
  types.test-d.ts       — compile-time signature checks.
```

`package.json` exposes two subpaths:

- `snabditel` → `dist/index.js` (browser-safe).
- `snabditel/als` → `dist/als-index.js` (node-only).

## Behavior

Preserved from prior iterations:

- Single-flight dedupe of concurrent resolves of the same token.
- Cache eviction on rejected build (no partial writes — cache writes happen post-build inside `placeIntoCache`).
- Default scope when `injectionScope` is unset and there are no deps → `singleton`.
- Explicit `transient` always allowed regardless of deps.
- Scoped seeds shadow singletons inside `run()`; outside, scope is unreachable.

Established by this design:

- Base `Snabditel.run()` is no longer single-flight; nested and parallel `run()` work without throwing.
- A token without `injectionScope` inherits the narrowest dep scope (was: silently singleton).
- A declared scope wider than the narrowest dep throws (was: silently captured stale).
- Both flavors share inheritance, validation, and cycle detection — all live on the base engine.

## Edge cases

- **Conditional deps in `createInstance`**: effective scope is fixed by deps observed on the *first* successful build. Subsequent resolves return the cached instance without re-evaluating. Documented limitation.
- **Plain class with explicit `injectionScope`**: validated identically. No deps → no validation triggered.
- **Build throws**: `inflight` deleted in `finally`, no cache writes. Waiters receive same rejection. Next resolve restarts cleanly.
- **Cross-run dedupe of unset → singleton**: builder writes to `singletons`. Waiters in any run that hit the in-flight entry adopt the singleton.
- **Cross-run dedupe of unset → scoped**: each run rebuilds via the waiter restart path.
- **Top-level concurrent resolves of distinct tokens with no shared deps**: each starts its own builder, each gets its own frame via `wrapAsync`. No interference.
- **Captured `s` after `run()` returns**: singleton resolves still work; scoped resolves still use the captured (now-stale) scope map. Documents `s`-as-value semantics.
- **Nested `run()` inside `createInstance`**: scope reset to a fresh map; frame chain inherited so an inner `s.resolve(self)` still trips cycle detection.

## Test plan

### `snabditel.test.ts` — browser-safe core

- Singleton/scoped/transient placement and caching.
- Seed: singleton, scoped (inside / outside run), transient (throws), symbol token, class token override.
- Unknown string token throws.
- `SelfResolvable.createInstance` is awaited.
- Sequential `run()` after prior completes.
- Single-flight: concurrent resolves of same singleton → one `createInstance`, same instance.
- Concurrent resolves with overlapping shared dep do **not** false-positive cycle.
- Singleton retries after rejected build (cache evicted).
- Parallel `run()` isolated, no cross-contamination, no ALS.
- Scope inheritance: undeclared inherits narrowest dep scope.
- Validation: declared `singleton` with scoped dep throws, message includes both names.
- Cycle detection via parent frame chain.
- Cross-run singleton race: same instance, single `createInstance`.
- Transient rebuilt per resolve, scoped deps shared in same run.
- Nested `run()`: scope reset, frame inherited (cycle survives across nesting).
- Captured `s` after `run()` end keeps using the captured scope map.
- **Static check**: `src/snabditel.ts` source does not match `/async_hooks/`.

### `als.test.ts` — ALS-specific

- `createInstance` using module-level `di.resolve` (no `s` arg) works — implicit propagation.
- Parallel `di.run`s with no explicit `s` threading — scoped values isolated.
- `di.seed(t, v, { injectionScope: "scoped" })` outside `run()` throws; inside, writes to ALS-current scope.
- Cycle detection works without `s` threading.

### `types.test-d.ts`

- `SelfResolvable.createInstance(s: ASnabditel)` typechecks as both newable static and object literal.
- `Scopeable.run` callback receives `s: ASnabditel`.
- A `() => T` `createInstance` is structurally assignable to `(s: ASnabditel) => T`.

## Out of scope

- Decorator-based registration.
- Auto-wiring by parameter types.
- Public exposure of `Ctx`, `Frame`, or `EMPTY_CTX` outside the package internals.
- Mutating a token's effective scope after first build.
