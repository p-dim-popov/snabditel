# Browser-safe concurrency for Snabditel

Date: 2026-05-10

## Motivation

`Snabditel` (base) is single-flight: nested or parallel `run()` throws. Users who want concurrent scopes must use `AlsSnabditel`, which depends on `node:async_hooks` and is therefore node-only.

Goal: make the base container support truly parallel `run()` scopes, browser-safe, with no `node:async_hooks` dependency. Achieved by making the active scope an explicit by-value resolver passed to the `run()` callback and to `createInstance`. ALS variant remains for users who want implicit propagation.

## Goals

- Parallel `run()` scopes work in the browser without ALS, without polyfills, without `AsyncContext`.
- Scope inheritance and lifetime validation parity with current `AlsSnabditel`.
- Two classes: `Snabditel` (browser-safe, default export) and `AlsSnabditel` (subpath `snabditel/als`, layers ALS on top).
- ALS users keep current ergonomics: callback `s` arg can be ignored; `await di.resolve(...)` inside `createInstance` keeps working.

## Non-goals

- `AsyncContext` (TC39 stage-3) integration. Future work, opt-in subpath if and when adopted.
- Zone.js or third-party context propagation.
- Backward compatibility with current single-flight base behavior or current `SelfResolvable.createInstance(): T` no-arg signature. Both are intentional breaking changes.

## API changes

### `snabditel.types.ts`

```ts
export type Resolver = {
  resolve<T>(token: Token<T>): Promise<T>;
};

export type SelfResolvable<T> = {
  // Resolver always passed; ALS users free to ignore the arg.
  createInstance(s: ASnabditel): T | Promise<T>;
  injectionScope?: InjectionScope;
};

export type Scopeable = {
  // Callback receives a scope-bound resolver. Browser variant requires its
  // use for scoped resolution; ALS variant works either way.
  run<T>(callback: (s: ASnabditel) => Promise<T>): Promise<T>;
};

// ASnabditel = Resolver & Seeder & Scopeable, unchanged otherwise.
```

`NewableResolvable<T> = new () => T` is unchanged (no-arg ctor). Newables stay no-deps; non-trivial wiring uses `SelfResolvable`.

### Classes

Two classes total in main entrypoint:

- `Snabditel` (default export): browser-safe, parallel scopes, scope inheritance + validation, no `node:async_hooks`.
- The scope-bound resolver `s` passed to `run` callbacks and `createInstance` is **not** a class. It's an object literal `{ resolve, seed, run }` produced by a private `makeScoped(ctx)` method on `Snabditel`. Closures inside it access `Snabditel`'s private state via captured `this`. Externally typed only as `ASnabditel`.

`AlsSnabditel` stays in subpath `snabditel/als` (§ ALS adapter).

## Internals

### Resolution context

```ts
type Key = unknown;
type Scope = Map<Key, unknown>;

type Ctx = {
  scope: Scope | null;      // null = no run() active
  frame: Frame | null;      // current resolution frame chain
};

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

// Frozen singleton for the no-active-scope ctx; avoids allocating a
// fresh `{ scope: null, frame: null }` on every outerCtx() hit.
const EMPTY_CTX: Ctx = Object.freeze({ scope: null, frame: null });
```

### Class layout

The scope-bound resolver `s` is **not** a separate class. It's an object literal built by a private method `makeScoped(ctx)`. The closures inside it access Snabditel's private state via captured `this`. The ALS variant overrides only two `protected` hooks — `outerCtx()` and `wrapAsync(ctx, fn)` — and never sees ALS-specific parameters in the base API.

```ts
export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  // Single root-level inflight map shared across all scopes; keyed by token.
  private inflight = new Map<Key, Promise<BuildResult<unknown>>>();

  /* Hooks (subclasses override) */

  /** Outer-level context. ALS variant returns the ALS-stored ctx; base = EMPTY_CTX. */
  protected outerCtx(): Ctx {
    return EMPTY_CTX;
  }

  /** Wrap an async region in subclass context machinery. Base = pass-through. */
  protected wrapAsync<T>(_ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /* Public ASnabditel surface */

  async run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> {
    const outer = this.outerCtx();
    // Fresh scope; inherit outer frame so cycle detection survives nested run().
    const ctx: Ctx = { scope: new Map(), frame: outer.frame };
    return this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
  }

  resolve<T>(token: Token<T>): Promise<T> {
    return this.resolveIn(token, this.outerCtx());
  }

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    const which = options.injectionScope ?? "singleton";
    if (which === "singleton") { this.singletons.set(token, value); return; }
    if (which === "scoped") {
      const target = this.outerCtx().scope;
      if (!target) throw new Error("Scoped seed requires an active run() scope");
      target.set(token, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  /* Engine — protected so subclasses (AlsSnabditel) can call it directly. */

  protected resolveIn<T>(token: Token<T>, ctx: Ctx): Promise<T> { /* see flow below */ }

  /* Closure factory for the per-scope resolver `s` */

  private makeScoped(ctx: Ctx): ASnabditel {
    return {
      resolve: <T>(token: Token<T>) => this.resolveIn(token, ctx),

      seed: <T>(token, value, options: SeedOptions = {}) => {
        const which = options.injectionScope ?? "singleton";
        if (which === "singleton") { this.singletons.set(token, value); return; }
        if (which === "scoped") {
          if (!ctx.scope) throw new Error("Scoped seed requires an active run() scope");
          ctx.scope.set(token, value);
          return;
        }
        throw new Error("Cannot seed a transient value");
      },

      run: <T>(cb: (s: ASnabditel) => Promise<T>) => {
        // Fresh scope; inherit current frame.
        const child: Ctx = { scope: new Map(), frame: ctx.frame };
        return this.wrapAsync(child, () => cb(this.makeScoped(child)));
      },
    };
  }
}
```

`s` is a plain object literal — not exported, not a class, no `ScopedSnabditel` type. Externally typed only as `ASnabditel`.

### `resolveIn(token, ctx)` flow

Mirrors current `als.ts` `resolve` shape:

1. **String/symbol token**: read from `ctx.scope` (if present) then `singletons`. Bubble source onto `ctx.frame`. Return.
2. **Singleton cache hit**: bubble `singleton`; return cached value.
3. **Scoped cache hit** (`ctx.scope?.has(token)`): bubble `scoped`; return cached.
4. **In-flight hit** (`inflight.has(token)`): cycle-check against `ctx.frame`, hand off to `waiter(token, pending, ctx)`.
5. **Otherwise**: `builder(token, ctx)`.

### `builder(token, ctx)`

1. `assertNoCycle(token, ctx.frame)`.
2. `frame: Frame = { ownerToken: token, declared: scopeOf(token), minScope: 'singleton', parent: ctx.frame }`.
3. `childCtx: Ctx = { scope: ctx.scope, frame }`. `childS = this.makeScoped(childCtx)`.
4. Register `pending: Promise<BuildResult<T>>` in `inflight` keyed by token. Suppress unhandled-rejection on it.
5. `value = await this.wrapAsync(childCtx, () => this.build(token, childS))`. Where `build` calls `token.createInstance(childS)` for `SelfResolvable`, `new token()` for newable. The `wrapAsync` call ensures the ALS variant pushes `childCtx` onto its store, so any `await di.resolve(...)` inside `createInstance` (without using `s`) sees the correct frame.
6. **Validation**: if `declared !== undefined && isWider(declared, frame.minScope)` → `mismatchError(token, declared, frame.minScope)`.
7. `effective = declared ?? frame.minScope`.
8. **Place into cache**:
   - `singleton` → `singletons.set(token, value)`.
   - `scoped` → require `ctx.scope`. If absent: throw `effectiveScopedNoRunError(token)` when inferred, generic `"Scoped resolution requires an active run() scope"` when declared.
   - `transient` → no cache.
9. `bubble(effective, ctx.frame)`.
10. Settle pending with `{ value, effectiveScope: effective, builtInScope: ctx.scope }`. Clear from `inflight`.

### `waiter(token, pending, ctx)` (mirrors `als.ts`)

```ts
const result = await pending;
bubble(result.effectiveScope, ctx.frame);
if (result.effectiveScope === "singleton") return result.value;
if (result.effectiveScope === "scoped") {
  if (ctx.scope === result.builtInScope) return result.value;
  return this.resolveIn(token, ctx);   // restart in our scope
}
// transient → restart so each caller gets its own fresh instance.
return this.resolveIn(token, ctx);
```

### Helpers (move from current `als.ts` into `snabditel.ts`)

`narrower`, `isWider`, `scopeOf`, `ownerName`, `assertNoCycle`, `bubble`, `mismatchError`, `effectiveScopedNoRunError`. All become private methods on `Snabditel`.

### Cross-run singleton dedupe

Single root-level `inflight` map. Two parallel `run()`s racing on the same uncached singleton: the first call to `resolveIn` for that token registers `pending`; the second observes it and `waiter`s. After settle, value is cached in `singletons`. Subsequent resolves from any scope hit the cache.

For scoped tokens, `waiter` falls through to a restart when `ctx.scope !== result.builtInScope`, so a parallel sibling scope correctly builds its own instance.

## ALS adapter (`src/als.ts`)

ALS variant overrides only the two `protected` hooks. No `super` calls into `_underscore` methods, no leaky parameters, no shadowing of public surface.

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export class AlsSnabditel extends Snabditel {
  private ctxAls = new AsyncLocalStorage<Ctx>();

  protected outerCtx(): Ctx {
    return this.ctxAls.getStore() ?? EMPTY_CTX;
  }

  protected wrapAsync<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return this.ctxAls.run(ctx, fn);
  }
}
```

Behavior:

1. `outerCtx()` returns the current ALS-stored ctx, so base `resolve`, `seed`, and `run` all see the current scope/frame without explicit `s` threading.
2. `wrapAsync(ctx, fn)` pushes `ctx` onto ALS for the duration of `fn`. Base calls it around (a) the user callback in `run()` and (b) every per-build `createInstance` invocation. So nested `di.resolve(...)` inside `createInstance` (without using `s`) sees the correct frame for cycle/inheritance/validation.

Existing ALS users with `createInstance() { return new X(await di.resolve(...)); }` keep working: TS sees `createInstance(s: ASnabditel)` but they ignore the arg.

## Error catalog

| Trigger | Message |
|---|---|
| String/symbol token not seeded | `Unknown token: <t>. String and symbol tokens must be seeded before resolution.` |
| Scoped seed outside `run()` | `Scoped seed requires an active run() scope` |
| Transient seed | `Cannot seed a transient value` |
| Declared `scoped` resolve outside `run()` | `Scoped resolution requires an active run() scope` |
| Inferred-scoped resolve outside `run()` | `<Owner> effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.` |
| Declared wider than narrowest dep | `` Cannot resolve <Owner> as <declared>: depends on a <min> service. Either remove `injectionScope` to inherit '<min>', or set it to '<min>' or 'transient'. `` |
| Cycle | `Cycle detected during resolution` |

Removed: `run() already active — concurrent scopes require AlsSnabditel` (base now handles concurrency).

## Test plan

### `src/snabditel.test.ts` (replaces existing)

Becomes the primary black-box suite for the browser-safe core. Drop the current "run already active throws" test. Move applicable cases from `als.test.ts`:

- Singleton/scoped/transient placement and caching.
- Scope inheritance from narrowest dep when `injectionScope` omitted.
- Validation: declared wider than dep throws `mismatchError`.
- Validation: inferred-scoped resolve outside `run()` throws `effectiveScopedNoRunError`.
- Validation: declared-scoped resolve outside `run()` throws generic scoped error.
- Cycle detection via parent frame chain.
- Single-flight `inflight` dedupe within a scope.
- Scoped seeds shadow singletons inside `run()`.
- Transient seed throws.
- Newable resolution (no-arg ctor classes).

New cases:

- **Parallel run isolation**: `Promise.all([di.run(s => ...), di.run(s => ...)])` — each scope sees its own scoped values, no cross-contamination, singletons shared.
- **Nested run scope reset, frame preserved**: `s.run(cb2)` inside outer `cb` creates a fresh scope (no scoped value inheritance) but preserves the outer frame chain so cycle detection still triggers if `cb2` resolves a token already on the parent build path.
- **Captured-`s` after run end**: capture `s` from one run, use after `run()` resolves. Singleton resolves still work; scoped resolves still use the captured (now-stale) scope map. Documents `s`-as-value semantics.
- **Cross-run singleton race**: two parallel runs both miss a singleton; only one `createInstance` call observed; both get the same instance.
- **Propagation through `createInstance(s)`**: deep dep tree (singleton → scoped → transient) using `s` arg threading. Verify each layer gets correct cached/fresh instance.
- **Browser-safety static check**: `src/snabditel.ts` does not import `node:async_hooks` (grep test in suite).

### `src/als.test.ts` (slimmed)

Keep only ALS-specific behavior:

- `createInstance` doing `await di.resolve(Foo)` (no `s` arg) works — implicit propagation.
- Parallel `di.run`s with no explicit `s` threading — scoped values isolated.
- `di.seed(t, v, { injectionScope: "scoped" })` outside `run()` throws; inside, writes to ALS-current scope.
- Cycle/validation tests that specifically rely on `frameAls` propagation.

### `src/types.test-d.ts`

Update to reflect new `SelfResolvable.createInstance(s: ASnabditel)` and `Scopeable.run(cb: (s: ASnabditel) => Promise<T>)`.

## Migration impact

- **Breaking**: `SelfResolvable.createInstance` gains required `s` arg.
  - Base users: must update signatures. Most existing examples already do `await di.resolve(...)` from a module-level `di`; they need to switch to `await s.resolve(...)` for scoped correctness.
  - ALS users: TS-level break only. Runtime keeps working with `s` ignored.
- **Behavioral upgrade (non-breaking)**: base `Snabditel.run` is no longer single-flight. Nested/parallel `run` no longer throws.
- **Surface**: `seed` and `resolve` signatures unchanged.

## File layout

- `src/snabditel.ts` — `Snabditel`, private `makeScoped(ctx)` closure factory, all helpers, `Ctx`/`Frame`/`BuildResult` types.
- `src/snabditel.types.ts` — updated `ASnabditel`, `SelfResolvable`, `Scopeable`.
- `src/als.ts` — slim `AlsSnabditel extends Snabditel` overriding only `outerCtx()` and `wrapAsync(ctx, fn)`.
- `src/snabditel.test.ts` — replaced; absorbs ALS-independent black-box cases.
- `src/als.test.ts` — slimmed to ALS-specific behavior.
- `src/types.test-d.ts` — updated signatures.
- `README.md` — sections updated per below.

## README updates

### Tagline (line 11)

```
- `Snabditel` — explicit-scope `run()`, browser-safe, parallel scopes.
- `AlsSnabditel` — `AsyncLocalStorage`-backed propagation; node-only.
```

### TanStack Start

Register the DI scope as **global request middleware** in `src/start.ts`. This wraps every request (server routes, SSR, server functions) in a fresh `di.run` scope. ALS propagates `s` implicitly, so handlers keep using module-level `di.resolve(...)`.

```ts
// src/di.ts
import { AlsSnabditel } from "snabditel/als";

export const di = new AlsSnabditel();

export class UserService {
  static readonly injectionScope = "scoped" as const;
  static createInstance() { return new UserService(); }
  list() { return [{ id: 1 }]; }
}
```

```ts
// src/start.ts
import { createStart, createMiddleware } from "@tanstack/react-start";
import { di } from "./di";

const diMiddleware = createMiddleware().server(({ next }) =>
  di.run((_s) => next()),   // ALS propagates ctx; _s unused inside next()
);

export const startInstance = createStart(() => ({
  requestMiddleware: [diMiddleware],
}));
```

Handlers anywhere in the app:

```ts
// any server route, server function, or loader
import { di, UserService } from "./di";

const users = await di.resolve(UserService);   // sees the request's scope via ALS
```

Use `functionMiddleware` instead of `requestMiddleware` to limit the scope to server-function calls only.

### React + React Query (replaces current section)

Browser side. Each `queryFn` opens its own `di.run(s => ...)`. `Api` is `transient` to demonstrate scope propagation; `AuthToken` is `scoped` so all transients in one query share the same auth view.

```ts
// di.ts
import { Snabditel, type ASnabditel } from "snabditel";

export const di = new Snabditel();

export class AppConfig {
  static createInstance() {
    return new AppConfig({ backendUrl: import.meta.env.VITE_BACKEND_URL });
  }
  constructor(private cfg: { backendUrl: string }) {}
  get backendUrl() { return this.cfg.backendUrl; }
}

export class AuthToken {
  static readonly injectionScope = "scoped" as const;
  static async createInstance() {
    return new AuthToken(await loadToken());
  }
  constructor(public value: string) {}
}

export class Api {
  static readonly injectionScope = "transient" as const;
  static async createInstance(s: ASnabditel) {
    return new Api(await s.resolve(AppConfig), await s.resolve(AuthToken));
  }
  constructor(private config: AppConfig, private auth: AuthToken) {}
  async request(path: string, init?: RequestInit) {
    return fetch(`${this.config.backendUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${this.auth.value}` },
    });
  }
}

export class UsersClient {
  // No injectionScope → inferred transient (narrowest dep = Api).
  static async createInstance(s: ASnabditel) {
    return new UsersClient(await s.resolve(Api));
  }
  constructor(private api: Api) {}
  list() { return this.api.request("/users").then((r) => r.json()); }
}
```

```ts
// users.queries.ts
import { queryOptions } from "@tanstack/react-query";
import { di, UsersClient } from "./di";

export const usersQueryOptions = queryOptions({
  queryKey: ["users"],
  queryFn: () =>
    di.run(async (s) => {
      const users = await s.resolve(UsersClient);
      return users.list();
    }),
});
```

```tsx
// Users.tsx
import { useQuery } from "@tanstack/react-query";
import { usersQueryOptions } from "./users.queries";

export function Users() {
  const { data } = useQuery(usersQueryOptions);
  return <ul>{data?.map((u: any) => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

Propagation: `queryFn` opens scope → `s.resolve(UsersClient)` → `UsersClient.createInstance(s)` → `s.resolve(Api)` → `Api.createInstance(s)` → `s.resolve(AppConfig)` (singleton, root cache) + `s.resolve(AuthToken)` (scoped, cached on `s`). Two parallel `useQuery`s = two parallel `di.run`s = two isolated `AuthToken`s. `Api` rebuilt each resolve (transient). All in browser, no `node:async_hooks`.

Drop the closing caveat about swapping to `AlsSnabditel` for browser scoping.

### Concurrent scopes (now base)

Title shifts; example moves to base `Snabditel`:

```ts
import { Snabditel } from "snabditel";

const di = new Snabditel();

class RequestHandler {
  static async createInstance(s: ASnabditel) {
    return new RequestHandler(await s.resolve(Logger));
  }
  constructor(private logger: Logger) {}
  async handle(req: Request) { /* ... */ }
}

await Promise.all([
  di.run(async (s) => {
    const h = await s.resolve(RequestHandler);
    return h.handle(req1);
  }),
  di.run(async (s) => {
    const h = await s.resolve(RequestHandler);
    return h.handle(req2);
  }),
]);
```

Note: `AlsSnabditel` (subpath `snabditel/als`) extends this with implicit `s` propagation via `node:async_hooks`, so callbacks and `createInstance` may ignore the `s` arg.

### API summary block

```ts
class Snabditel implements ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() — s arg optional in practice; same inheritance + validation
```
