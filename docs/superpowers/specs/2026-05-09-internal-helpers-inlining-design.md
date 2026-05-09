# Inline `internal/` helpers and clean up post-inheritance Snabditel

Date: 2026-05-09
Status: Approved (design)
Scope: `AlsSnabditel` + `Snabditel`. No public API changes.

## Problem

Two issues compound:

1. `src/internal/scope-helpers.ts` and `src/internal/seed-helpers.ts` export "flying" free functions that are only consumed by `AlsSnabditel`. The functions live outside the class because of an earlier era when `AlsSnabditel extends Snabditel`. With the class hierarchy gone, the indirection costs more than it buys: every helper carries a callback or extra `singletons`/`getScope` argument that would be a plain `this.*` access if it were a method.
2. `Snabditel` still has `protected` members (`singletons`, `localScope`, `getScope`, `build`) that exist only to support the now-removed subclass. Its `resolve()` mixes seed-token lookup, scope-of-binding logic, cache selection, and build dispatch in a single method.

## Goals

1. Remove `src/internal/`. Move every helper into the class that uses it as a `private` instance method.
2. Tighten `Snabditel` access modifiers: `protected` → `private`. Restructure `resolve()` for readability.
3. Preserve all current behavior, error messages, and public API. No export changes.
4. Preserve test coverage. Helper unit tests delete; their behaviors port to `als.test.ts` as black-box assertions on `AlsSnabditel`.

## Non-goals

- No new features in `AlsSnabditel` or `Snabditel`.
- No change to error message wording.
- No change to package `exports` map, build scripts, or distributed surface.
- No change to `Snabditel` resolution semantics. Restructure is purely organizational.

## Architecture

```
ASnabditel (interface, unchanged)
├── Snabditel       — private members, resolve() split into resolveSeeded / resolveBinding
└── AlsSnabditel    — absorbs all helpers from src/internal/ as private instance methods
```

`src/internal/` directory is deleted. No file in `src/` imports from it after this change (verified by `grep`).

## File layout

```
src/
  als.ts                  # AlsSnabditel + private helpers (no internal imports)
  als.test.ts             # adds ported scope/seed helper coverage
  als-index.ts            # unchanged
  snabditel.ts            # private members, resolve() restructured
  snabditel.test.ts       # unchanged
  snabditel.types.ts      # unchanged
  index.ts                # unchanged
  types.test-d.ts         # unchanged
  # internal/             ← deleted (entire directory)
```

## AlsSnabditel structure

Module-level types stay in `als.ts`: `Key`, `Scope`, `Frame`, `BuildResult`. Module-level `RANK` lookup table stays (data, not function).

```ts
export class AlsSnabditel implements ASnabditel {
  private singletons = new Map<Key, unknown>();
  private scopeAls = new AsyncLocalStorage<Scope>();
  private frameAls = new AsyncLocalStorage<Frame>();
  private inFlight = new Map<Key, Promise<BuildResult<unknown>>>();

  // Public API
  async run<T>(callback: () => Promise<T>): Promise<T>;
  seed<T>(token, value, options): void;
  async resolve<T>(token: Token<T>): Promise<T>;

  // Private — scope math (was scope-helpers.ts)
  private narrower(a: InjectionScope, b: InjectionScope): InjectionScope;
  private isWider(declared: InjectionScope, min: InjectionScope): boolean;
  private scopeOf<T>(binding: Resolvable<T>): InjectionScope | undefined;
  private ownerName<T>(binding: Resolvable<T>): string;
  private mismatchError<T>(binding, declared, min): Error;
  private effectiveScopedNoRunError<T>(binding): Error;

  // Private — seeds (was seed-helpers.ts)
  private writeSeed<T>(token, value, options): void;
  private readSeedToken<T>(token: string | symbol): Promise<{ value: T; source: SeedSource }>;

  // Private — resolution machinery
  private currentScope(): Scope | null;     // this.scopeAls.getStore() ?? null
  private bubble(scope: InjectionScope): void;
  private build<T>(token: Resolvable<T>): Promise<T>;
  private builder<T>(token: Resolvable<T>): Promise<T>;
  private waiter<T>(token, pending): Promise<T>;
  private placeIntoCache<T>(token, value, effective, builtInScope, declared): void;
  private assertNoCycle(token, startFrame): void;
}
```

Notes:

- All scope-math helpers become `private` instance methods (per user direction). Stateless but uniform style with stateful methods on the same class.
- `writeSeed` no longer takes a `getScope` callback. Reads `this.currentScope()` directly.
- `readSeedToken` no longer takes `singletons` or `currentScope` arguments. Reads `this.singletons` and `this.currentScope()` directly.
- `seed()` body becomes `this.writeSeed(token, value, options)`.
- The `string|symbol` branch of `resolve()` becomes:
  ```ts
  const result = await this.readSeedToken<T>(token);
  this.bubble(result.source);
  return result.value;
  ```
- Cycle-detection helper `assertNoCycle` already private — stays.
- `SeedSource = "singleton" | "scoped"` type stays (was exported from `seed-helpers.ts`; in `als.ts` it can be a module-level type or inlined).

## Snabditel structure

```ts
export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private localScope: Scope | null = null;

  seed<T>(token, value, options = {}): void {
    const injectionScope = options.injectionScope ?? "singleton";
    if (injectionScope === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (injectionScope === "scoped") {
      if (!this.localScope) throw new Error("Scoped seed requires an active run() scope");
      this.localScope.set(token, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.localScope) {
      throw new Error("run() already active — concurrent scopes require AlsSnabditel");
    }
    this.localScope = new Map();
    try {
      return await callback();
    } finally {
      this.localScope = null;
    }
  }

  async resolve<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      return this.resolveSeeded<T>(token);
    }
    return this.resolveBinding<T>(token);
  }

  private async resolveSeeded<T>(token: string | symbol): Promise<T> {
    if (this.localScope?.has(token)) return (await this.localScope.get(token)) as T;
    if (this.singletons.has(token)) return (await this.singletons.get(token)) as T;
    throw new Error(
      `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
    );
  }

  private async resolveBinding<T>(token: Resolvable<T>): Promise<T> {
    const injectionScope =
      ("injectionScope" in token ? token.injectionScope : undefined) ?? "singleton";

    if (injectionScope === "singleton") return this.cacheBuild(this.singletons, token);
    if (injectionScope === "scoped") {
      if (!this.localScope) throw new Error("Scoped resolution requires an active run() scope");
      return this.cacheBuild(this.localScope, token);
    }
    return this.build(token); // transient
  }

  private cacheBuild<T>(cache: Scope, token: Resolvable<T>): Promise<T> {
    if (cache.has(token)) {
      return Promise.resolve(cache.get(token) as T | Promise<T>);
    }
    const p = this.build(token);
    cache.set(token, p);
    p.catch(() => {
      if (cache.get(token) === p) cache.delete(token);
    });
    return p;
  }

  private async build<T>(binding: Resolvable<T>): Promise<T> {
    if ("createInstance" in binding) return await binding.createInstance();
    return new binding();
  }
}
```

Changes vs current:

- `protected` → `private` on `singletons`, `localScope`, `build`. `getScope()` removed; callers read `this.localScope` directly.
- Inlined `scopeOf()` (single call site, three lines).
- `resolve()` becomes a three-line dispatch; logic split into `resolveSeeded` / `resolveBinding`.
- All error messages, throw sites, and conditions identical to current code.
- `seed()` body inline (not a private helper). Single call site, simple branching.

## Test migration

Delete:

- `src/internal/scope-helpers.test.ts`
- `src/internal/seed-helpers.test.ts`

Behaviors port to `als.test.ts` as black-box assertions on `AlsSnabditel`.

`als.test.ts` already covers (verify during implementation, no new test if covered):

- Scope inheritance / narrowing (covers `narrower`).
- Mismatch error when declared wider than dep (covers `isWider` + `mismatchError`).
- Seed singleton, seed scoped (with and without active run), seed transient throws (covers `writeSeed` paths).
- Seeded token resolve, unknown token throws (covers `readSeedToken` paths).

Add to `als.test.ts` for cases only the deleted unit tests assert today:

1. `mismatchError` shape — message includes owner name, declared scope, min scope, the phrases `inherit '<min>'` and `'<min>' or 'transient'`. Two cases:
   - Named class owner.
   - Anonymous SelfResolvable owner (object literal) — should produce `anonymous SelfResolvable`.
2. `effectiveScopedNoRunError` shape — message includes owner name, `'scoped'`, `inherited from a scoped dependency`, `run() scope`.
3. `ownerName` edge cases (asserted via mismatchError messages):
   - Anonymous class (constructor `name` is empty string) → `anonymous class`.
   - SelfResolvable instance whose constructor has a name → constructor name.
4. Seed read semantics:
   - Scope hit shadows singleton for the same string token.
   - Cached promise values are awaited (seed a `Promise.resolve(v)` under a string token, resolve it, expect `v`).

`snabditel.test.ts` — unchanged. Snabditel behavior didn't change.
`types.test-d.ts` — unchanged.

## Error handling

Unchanged. Every existing throw site preserved with identical message text:

- `Unknown token: <token>. String and symbol tokens must be seeded before resolution.`
- `Scoped seed requires an active run() scope`
- `Cannot seed a transient value`
- `Scoped resolution requires an active run() scope`
- `Cycle detected during resolution`
- `Cannot resolve <name> as <declared>: depends on a <min> service. Either remove `injectionScope` to inherit '<min>', or set it to '<min>' or 'transient'.`
- `<name> effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.`
- `run() already active — concurrent scopes require AlsSnabditel` (Snabditel only)

## Data flow

Unchanged.

- AlsSnabditel: `scopeAls` (current scope map per ALS context), `frameAls` (resolution-frame chain for cycle detection and scope bubbling), `inFlight` (per-token in-flight build promise for single-flight dedupe), `singletons` (cross-context singletons cache).
- Snabditel: `localScope` (single active run scope, mutually exclusive), `singletons`.

## Risks and mitigations

- **Lost granular assertions.** Helper unit tests delete; their cases port to `als.test.ts`. Mitigation — explicit checklist in "Test migration" maps every helper-test case to a black-box equivalent before deletion.
- **Accidental behavior drift in Snabditel `resolve()` restructure.** Mitigation — `snabditel.test.ts` runs unchanged and must stay green.
- **Stale imports of `internal/`.** Mitigation — `grep -rn "internal/" src` after refactor must return zero matches.
- **Build artifact surface drift.** Mitigation — `bun run build` and inspect `dist/types/*.d.ts` for unintended public-type changes.

## Verification (implementation time)

- `bun run typecheck` — clean.
- `bun test` — all existing tests green.
- New black-box message-shape tests in `als.test.ts` — green.
- `grep -rn "internal/" src` — zero results.
- `bun run build` — succeeds. Diff `dist/` against pre-change tree; only file removals (internal helpers' compiled output) and the restructured `als.js` / `snabditel.js` should differ.

## Out of scope

- Any change to `ASnabditel` interface or any public type.
- Any change to test framework, build tooling, or package layout beyond removing `src/internal/`.
- Any feature work in `AlsSnabditel` or `Snabditel`.
