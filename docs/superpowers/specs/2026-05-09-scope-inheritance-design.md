# Scope Inheritance and Validation (AlsSnabditel)

Date: 2026-05-09
Status: Approved (design)
Scope: `AlsSnabditel` only. Base `Snabditel` unchanged.

## Problem

When a service depends on a service with a narrower scope, the parent silently captures a stale instance.

Example:

```ts
class A {
  static readonly injectionScope = "scoped";
  static createInstance() { return new A(); }
}
class B {
  // no injectionScope, defaults to singleton today
  static async createInstance() {
    const a = await di.resolve(A);
    return new B(a);
  }
}

await di.run(async () => {
  await di.resolve(B); // B singleton-cached, holds A from this run
});
await di.run(async () => {
  await di.resolve(B); // returns same B with stale A from prior run
});
```

The container should either infer the correct narrower scope for `B`, or refuse to resolve `B` when its declared scope is too wide for its dependencies.

## Goals

1. When a token has no explicit `injectionScope`, infer the narrowest scope of its dependencies as its effective scope.
2. When a token has an explicit `injectionScope` that is wider than its narrowest dependency, throw a clear error.
3. Preserve current single-flight dedupe semantics for concurrent in-flight builds where possible.
4. No public API breakage. Existing tests continue to pass.

## Non-goals

- Static (build-time) validation. Inference is at first resolution.
- Re-validation after a token is cached.
- Cycle detection (already absent in current code; out of scope).
- Inheritance/validation in base `Snabditel`. Feature lives only in `AlsSnabditel`.

## Architecture

`AlsSnabditel` and `Snabditel` diverge. Both implement `ASnabditel` directly; `AlsSnabditel` no longer `extends` `Snabditel`.

```
ASnabditel (type)
├── Snabditel       — unchanged. No ALS, no inheritance, no validation.
└── AlsSnabditel    — standalone. ALS-backed scope + frame. Inheritance + validation.
```

Shared via composition (small helpers, not class hierarchy):

- `seed-helpers.ts` — pure functions for seed write + string/symbol token lookup. Used by both classes.
- `scope-helpers.ts` — `narrower(a, b)`, `isWider(declared, min)`, `scopeOf(token)`.

`AlsSnabditel` owns its build engine; `Snabditel` keeps its current `cacheBuild` flow untouched.

## Scope rules

Lifetime ordering, narrowest to widest:

```
transient  →  scoped  →  singleton
```

Validity (parent scope must be ≤ narrowest dependency scope):

| parent \ dep | transient | scoped | singleton |
|---|---|---|---|
| transient | ok | ok | ok |
| scoped | error | ok | ok |
| singleton | error | error | ok |

Inheritance for unset parent:

- No deps → singleton.
- Deps `{singleton}` → singleton.
- Deps `{singleton, scoped}` → scoped.
- Deps `{singleton, transient}` → transient.
- Deps `{scoped, transient}` → transient.

Applies to both `NewableResolvable` (plain class) and `SelfResolvable` without `injectionScope`. Plain classes have no `createInstance` so no deps; effective stays singleton.

## Dependency scope sources

- Class / SelfResolvable with explicit `injectionScope` → that value.
- Class / SelfResolvable without `injectionScope` → its computed effective scope (recursively determined; cached on first build).
- String / symbol seed → cache location lookup. Found in `singletons` map → singleton. Found in current scope map → scoped. Transient seeds remain forbidden.

## AlsSnabditel internals

```ts
type Key = unknown;
type Scope = Map<Key, unknown>;

type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: Scope | null;
};

class AlsSnabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private scopeAls = new AsyncLocalStorage<Scope>();
  private frameAls = new AsyncLocalStorage<Frame>();
  private inFlight = new Map<Key, Promise<BuildResult<unknown>>>();
  // ...
}
```

`scopeAls` replaces base's `localScope` field with ALS storage.
`frameAls` carries the current build's scope-tracking frame across async boundaries.
`inFlight` provides single-flight dedupe even when caching is deferred.

### `run`

```
async run(cb):
  return scopeAls.run(new Map(), cb)
```

Concurrent / nested `run()` calls are allowed (each gets its own scope map). Same as today.

### `seed`

Same logic as base: write to singletons or to the current ALS scope. `transient` throws. String / symbol / class tokens supported.

### `resolve` (high level)

```
resolve(token):
  notify current frame about the dep we're about to resolve

  if string/symbol:
    return resolveSeed(token)        // bubbles cache-location to frame

  if singletons has token:
    bubble singleton to frame
    return cached

  if currentScope has token:
    bubble scoped to frame
    return cached

  if inFlight has token:
    return waiter(token)              // §waiter

  return builder(token)               // §builder
```

`bubble(scope)` updates the current frame's `minScope` via `narrower(frame.minScope, scope)`. No-op if no current frame.

If the current frame's owner has a declared scope and the new `minScope` is narrower than declared (i.e. `isWider(declared, minScope)`), `bubble` throws the mismatch error immediately. This aborts `createInstance` early on the first violating dep — avoiding further side effects in `createInstance`. To support this, frames carry the owner's declared scope and the owner ref:

```ts
type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
};
```

### Builder

```
builder(token):
  declared = scopeOf(token)            // from `injectionScope` static, or undefined
  frame = { ownerToken: token, declared, minScope: 'singleton' }
  pending = deferred()
  inFlight.set(token, pending.promise)

  try {
    value = await frameAls.run(frame, async () => {
      if ('createInstance' in token) return await token.createInstance()
      return new token()
    })

    if (declared !== undefined && isWider(declared, frame.minScope)) {
      throw mismatchError(token, declared, frame.minScope)
    }
    effective   = declared ?? frame.minScope
    builtInScope = scopeAls.getStore() ?? null

    placeIntoCache(token, value, effective, builtInScope)
    bubble(effective)                  // tell parent frame what we ended up as

    pending.resolve({ value, effectiveScope: effective, builtInScope })
    return value
  } catch (e) {
    pending.reject(e)
    throw e
  } finally {
    inFlight.delete(token)
  }
```

`placeIntoCache(token, value, effective, builtInScope, declared)`:

| effective | action |
|---|---|
| singleton | `singletons.set(token, value)` |
| scoped | if `builtInScope === null` → throw §errors "Effective scoped, no run scope" if `declared === undefined`, else throw existing "Scoped resolution requires an active run() scope". Else `builtInScope.set(token, value)`. |
| transient | no cache write |

### Waiter

```
waiter(token):
  result = await inFlight.get(token)
  bubble(result.effectiveScope)        // dep info still bubbles up

  switch (result.effectiveScope):
    case 'singleton':
      return result.value              // already in singletons, no further work
    case 'scoped':
      if scopeAls.getStore() === result.builtInScope:
        return result.value            // same run, value already in this scope map
      return resolve(token)            // different run / no run, restart
    case 'transient':
      return resolve(token)            // each caller gets a fresh build
```

Restart paths re-enter `resolve`. The original `inFlight` entry is gone by then (deleted in builder's `finally`), so the restarter becomes a builder (or finds a new in-flight one and waits again). Bounded — no infinite restart loop.

### Frame propagation

When a build is active, every nested `resolve` reports the dependency's effective scope to the parent frame via `bubble`. `bubble` reads `frameAls.getStore()`; if no frame is active (top-level resolve), it does nothing.

When the inner build finishes, control returns inside the parent's `frameAls.run` callback, where the parent's frame is again the current store.

## Errors

### Mismatch (explicit owner wider than narrowest dep)

```
"Cannot resolve <ownerName> as <declaredScope>: depends on a <minScope> service.
 Either remove `injectionScope` to inherit '<minScope>', or set it to '<minScope>' or 'transient'."
```

`<ownerName>` resolution:
- Class token (function): `binding.name` if non-empty, else `"anonymous class"`.
- SelfResolvable object literal: `binding.constructor?.name` if not `"Object"`, else `"anonymous SelfResolvable"`.
- String / symbol token: `String(token)`. (Not applicable in these errors — strings/symbols are leaves, not owners.)

### Effective scoped, no run scope

```
"<ownerName> effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active."
```

### Existing errors (unchanged)

- `"Cannot seed a transient value"`
- `"Scoped seed requires an active run() scope"`
- `"Scoped resolution requires an active run() scope"` (still thrown for explicit-scoped tokens at the top of `resolve`, before the new flow)
- `"Unknown token: <x>. String and symbol tokens must be seeded before resolution."`

## API surface

No public API changes.

- `Snabditel` exports unchanged.
- `AlsSnabditel` exports unchanged externally. Internally rewritten to be standalone.

The new behavior surfaces only via `AlsSnabditel`. Code that was using `Snabditel` and wants the feature must switch to `AlsSnabditel`.

## Behavior preserved

- Single-flight dedupe of concurrent resolves of the same token via `inFlight`.
- Cache eviction on rejected build (no partial writes since cache writes happen post-build at step `placeIntoCache`).
- Default scope when no `injectionScope` and no deps → singleton.
- Explicit `transient` always allowed regardless of deps.

## Behavior changed (AlsSnabditel only)

- A token with `injectionScope: "singleton"` (explicit) that depends on a scoped or transient token now throws instead of silently caching a stale instance.
- A token with `injectionScope: "scoped"` (explicit) that depends on a transient token now throws.
- A token without `injectionScope` no longer defaults to singleton when it has narrower-scoped deps; it inherits the narrowest dep scope.

## Edge cases

- **Conditional deps in `createInstance`**: effective scope is fixed by deps observed on the first successful build. Subsequent resolves return the cached instance without re-evaluating `createInstance`. Documented limitation.
- **Plain class with explicit `injectionScope`**: validated identically. No deps → no validation triggered.
- **Build throws**: `inFlight` deleted in `finally`, no cache writes. Waiters receive same rejection. Next resolve restarts cleanly.
- **Cross-run dedupe of unset → singleton**: builder writes to `singletons`. Waiters in any run that hit the in-flight entry adopt the singleton.
- **Cross-run dedupe of unset → scoped**: each run rebuilds. The waiter restart logic ensures correctness across runs.
- **Top-level concurrent resolves of distinct tokens with no shared deps**: each starts its own build, each gets its own frame via `frameAls.run`. No interference.

## Test plan

Added to `src/als.test.ts` (these tests apply only to `AlsSnabditel`; `Snabditel` keeps its current tests unchanged):

1. Unset SelfResolvable depending on scoped dep → owner becomes scoped (different across runs).
2. Unset SelfResolvable depending on singleton dep only → owner stays singleton.
3. Unset SelfResolvable depending on transient dep → owner becomes transient.
4. Explicit `singleton` + scoped dep → throws with message including both names and `'scoped'`.
5. Explicit `singleton` + transient dep → throws.
6. Explicit `scoped` + transient dep → throws.
7. Explicit `transient` + scoped dep → ok.
8. Explicit `scoped` + singleton dep → ok.
9. Mixed deps `{singleton, scoped}` on unset owner → owner scoped.
10. Mixed deps `{singleton, scoped, transient}` on unset owner → owner transient.
11. String seed dep scope inferred from cache location: scoped seed → owner becomes scoped.
12. Concurrent same-run resolves of unset-scope token → single build (lock dedupes).
13. Concurrent cross-run resolves of unset → singleton effective → single build, all runs share value.
14. Concurrent cross-run resolves of unset → scoped effective → each run rebuilds with its own value.
15. Builder rejects → all waiters get same rejection, no cache writes.
16. Effective-scoped token resolved outside `run()` throws clear error.
17. `Snabditel` tests unchanged and still pass.

## Files

- `src/snabditel.ts` — unchanged.
- `src/snabditel.types.ts` — unchanged externally; possibly add internal types `BuildResult<T>`, `Frame` if exported from a shared internal module. Otherwise keep types private to `AlsSnabditel`.
- `src/als.ts` — rewritten. No `extends Snabditel`. Contains `AlsSnabditel` with all new logic.
- `src/internal/seed-helpers.ts` (new) — shared seed write + string/symbol lookup.
- `src/internal/scope-helpers.ts` (new) — `narrower`, `isWider`, `scopeOf`.
- `src/snabditel.ts` updated only to use the helpers (refactor without behavior change), if cleaner. Optional.
- `src/als.test.ts` — new tests per §test plan.

## Open questions

None. All design decisions resolved during brainstorming.
