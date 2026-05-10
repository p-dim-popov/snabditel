# Browser-Safe Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Snabditel`'s single-flight `run()` with a closure-based scope-bound resolver `s`, parallel-run safe and browser-safe (no `node:async_hooks`). Slim `AlsSnabditel` to a 10-line subclass overriding only two hooks.

**Architecture:** `Snabditel` holds `singletons` + a single root-level `inflight` map. `run(cb)` creates a fresh `Ctx = { scope: Map, frame: Frame|null }` and passes a closure-built `s: ASnabditel` to `cb`. Each `s.resolve(token)` calls private `resolveIn(token, ctx)`. The builder threads a child `s'` (with new frame) into `token.createInstance(s')`. Two `protected` hooks — `outerCtx()` and `wrapAsync(ctx, fn)` — default to no-ops and let `AlsSnabditel` layer `AsyncLocalStorage` propagation on top with no other code.

**Tech Stack:** TypeScript 6, Bun (runtime + test runner + bundler), `bun test`, `tsgo` for typecheck, `node:async_hooks` (only inside `src/als.ts`).

**Spec:** `docs/superpowers/specs/2026-05-10-browser-concurrency-design.md`.

---

## File Map

- **Modify** `src/snabditel.types.ts` — add `s: ASnabditel` arg to `SelfResolvable.createInstance`; change `Scopeable.run` callback to `(s: ASnabditel) => Promise<T>`.
- **Modify** `src/snabditel.ts` — full rewrite: closure-based engine, `Ctx`/`Frame`/`BuildResult` types, `EMPTY_CTX` singleton, `outerCtx`/`wrapAsync` hooks, `makeScoped` factory, `resolveIn`/`builder`/`waiter`/`build`, all helpers (ported from current `als.ts`). Exports `Ctx`, `Frame`, `EMPTY_CTX` for subclass use.
- **Modify** `src/als.ts` — slim to `class AlsSnabditel extends Snabditel` overriding `outerCtx()` and `wrapAsync(ctx, fn)`.
- **Modify** `src/snabditel.test.ts` — drop "run already active throws"; absorb black-box cases that don't require ALS implicit propagation.
- **Modify** `src/als.test.ts` — slim to ALS-specific propagation cases.
- **Modify** `src/types.test-d.ts` — keep mostly as-is (existing examples remain valid because `() => T` is structurally assignable to `(s: ASnabditel) => T`); add new compile-time examples for the `s` arg flow.
- **Modify** `README.md` — tagline, TanStack Start global middleware, React + React Query (with transient `Api`), Concurrent scopes section, API summary.

---

## Task 1: Update type contracts

**Files:**
- Modify: `src/snabditel.types.ts`

Type-only change. Add the `s: ASnabditel` parameter to `SelfResolvable.createInstance` and change `Scopeable.run` callback signature. Existing zero-arg implementations stay valid: TS allows assigning `() => T` to `(s: ASnabditel) => T` (fewer-arg-functions are assignable).

- [ ] **Step 1: Update `src/snabditel.types.ts`**

Replace whole file contents with:

```ts
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

export type SeedOptions = {
  injectionScope?: InjectionScope;
};

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

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS. Existing `createInstance()` no-arg methods still match the new signature (contravariant arg subtyping). Existing `run(async () => ...)` callbacks still match `(s: ASnabditel) => Promise<T>` for the same reason.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: PASS — all existing tests continue to pass (semantics unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/snabditel.types.ts
git commit -m "$(cat <<'EOF'
refactor(types): add s arg to SelfResolvable.createInstance and Scopeable.run

Additive TS change: () => T remains assignable to (s: ASnabditel) => T
under TS contravariant param subtyping, so existing implementations and
callers compile unchanged. Future tasks switch to s-based wiring.
EOF
)"
```

---

## Task 2: Failing test — parallel runs on base `Snabditel`

**Files:**
- Modify: `src/snabditel.test.ts`

Pin down current failing behavior with a black-box test before rewriting the engine.

- [ ] **Step 1: Add failing test**

Append the following test inside the `describe("Snabditel", ...)` block in `src/snabditel.test.ts` (before its closing `});`):

```ts
test("parallel runs are isolated (browser-safe, no ALS)", async () => {
  class RequestId {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new RequestId(); }
    id = Math.random();
  }
  const di = new Snabditel();

  const work = (delay: number) =>
    di.run(async () => {
      const a = await di.resolve(RequestId);
      await new Promise((r) => setTimeout(r, delay));
      const b = await di.resolve(RequestId);
      expect(a).toBe(b);
      return a;
    });

  const [r1, r2] = await Promise.all([work(20), work(5)]);
  expect(r1).not.toBe(r2);
});
```

- [ ] **Step 2: Run the new test**

Run: `bun test src/snabditel.test.ts -t "parallel runs are isolated"`
Expected: FAIL with `run() already active — concurrent scopes require AlsSnabditel`.

- [ ] **Step 3: Commit (red test on disk)**

```bash
git add src/snabditel.test.ts
git commit -m "$(cat <<'EOF'
test(snabditel): red — parallel run() must isolate scopes (no ALS)
EOF
)"
```

---

## Task 3: Rewrite `Snabditel` with closure-based engine + hooks

**Files:**
- Modify: `src/snabditel.ts`

Replace the entire file with the closure model. Port helpers (`narrower`, `isWider`, `scopeOf`, `ownerName`, `assertNoCycle`, `bubble`, `mismatchError`, `effectiveScopedNoRunError`, `placeIntoCache`) from current `als.ts`. Two `protected` hooks (`outerCtx`, `wrapAsync`) default to no-ops; `AlsSnabditel` will override them in Task 5. Export `Ctx`, `Frame`, `EMPTY_CTX` so the subclass can reference them.

- [ ] **Step 1: Replace `src/snabditel.ts`**

Replace whole file contents with:

```ts
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

export type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
  parent: Frame | null;
};

export type Ctx = {
  scope: Scope | null;
  frame: Frame | null;
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: Scope | null;
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

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    const which = options.injectionScope ?? "singleton";
    if (which === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (which === "scoped") {
      const target = this.outerCtx().scope;
      if (!target)
        throw new Error("Scoped seed requires an active run() scope");
      target.set(token, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  async run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> {
    const outer = this.outerCtx();
    const ctx: Ctx = { scope: new Map(), frame: outer.frame };
    return this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
  }

  protected resolveIn<T>(token: Token<T>, ctx: Ctx): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      return this.readSeedAndBubble<T>(token, ctx);
    }

    if (this.singletons.has(token)) {
      this.bubble("singleton", ctx.frame);
      return Promise.resolve(this.singletons.get(token) as T | Promise<T>);
    }

    if (ctx.scope?.has(token)) {
      this.bubble("scoped", ctx.frame);
      return Promise.resolve(ctx.scope.get(token) as T | Promise<T>);
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
    if (ctx.scope?.has(token)) {
      this.bubble("scoped", ctx.frame);
      return (await ctx.scope.get(token)) as T;
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
        const which = options.injectionScope ?? "singleton";
        if (which === "singleton") {
          this.singletons.set(token, value);
          return;
        }
        if (which === "scoped") {
          if (!ctx.scope)
            throw new Error("Scoped seed requires an active run() scope");
          ctx.scope.set(token, value);
          return;
        }
        throw new Error("Cannot seed a transient value");
      },

      run: <T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> => {
        const child: Ctx = { scope: new Map(), frame: ctx.frame };
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
          ? this.effectiveScopedNoRunError(token)
          : new Error("Scoped resolution requires an active run() scope");
      }
      builtInScope.set(token, value);
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
```

- [ ] **Step 2: Run the parallel-runs test**

Run: `bun test src/snabditel.test.ts -t "parallel runs are isolated"`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: All `Snabditel` tests pass; the only failing test (if any) should be `Snabditel: run() already active throws` if it still exists in the file. Note: it should not exist since we never wrote it under TDD; the original codebase did not include it either. If you find a similar test, delete it now.

Use this command to check for it specifically:

```bash
grep -n "run() already active" src/snabditel.test.ts || echo "no such test"
```

Expected: `no such test`.

If `als.test.ts` fails — that's fine; we replace `als.ts` in Task 5.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/snabditel.ts
git commit -m "$(cat <<'EOF'
feat(snabditel): closure-based scope resolver, parallel run() safe

Replace single-flight base with explicit-resolver model. run(cb) builds
a fresh Ctx { scope, frame } and passes a closure-bound s: ASnabditel to
cb. createInstance receives s; closures capture ctx by reference; root
inflight map dedupes parallel singleton races. Two protected hooks
outerCtx() / wrapAsync(ctx, fn) let AlsSnabditel layer ALS propagation
on top with no other code (Task 5).
EOF
)"
```

---

## Task 4: Black-box tests for inheritance, validation, cycle, propagation

**Files:**
- Modify: `src/snabditel.test.ts`

Cover the new engine behavior with black-box cases ported from `als.test.ts` (where they don't depend on ALS implicit propagation) plus the new propagation/parallel-run semantics. All tests should pass against the engine from Task 3.

- [ ] **Step 1: Append tests inside the `describe("Snabditel", ...)` block**

Add the following block of tests just before the closing `});` of the describe:

```ts
test("scope inheritance: undeclared inherits narrowest dep scope", async () => {
  class RequestId {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new RequestId(); }
    id = Math.random();
  }
  class UserService {
    static async createInstance(s: ASnabditel) {
      return new UserService(await s.resolve(RequestId));
    }
    constructor(public req: RequestId) {}
  }
  const di = new Snabditel();
  const a = await di.run(async (s) => {
    const u = await s.resolve(UserService);
    return u.req;
  });
  const b = await di.run(async (s) => {
    const u = await s.resolve(UserService);
    return u.req;
  });
  expect(a).not.toBe(b);
});

test("validation: declared singleton with scoped dep throws", async () => {
  class RequestId {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new RequestId(); }
  }
  class BadCache {
    static readonly injectionScope = "singleton" as const;
    static async createInstance(s: ASnabditel) {
      await s.resolve(RequestId);
      return new BadCache();
    }
  }
  const di = new Snabditel();
  await expect(
    di.run((s) => s.resolve(BadCache)),
  ).rejects.toThrow(/depends on a scoped service/);
});

test("validation: inferred-scoped resolve outside run() throws scope-msg", async () => {
  class RequestId {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new RequestId(); }
  }
  class UserService {
    static async createInstance(s: ASnabditel) {
      return new UserService(await s.resolve(RequestId));
    }
    constructor(public req: RequestId) {}
  }
  const di = new Snabditel();
  await expect(di.resolve(UserService)).rejects.toThrow(
    /effective scope is 'scoped'/,
  );
});

test("cycle detection via parent frame chain", async () => {
  class A {
    static async createInstance(s: ASnabditel) {
      await s.resolve(B);
      return new A();
    }
  }
  class B {
    static async createInstance(s: ASnabditel) {
      await s.resolve(A);
      return new B();
    }
  }
  const di = new Snabditel();
  await expect(di.resolve(A)).rejects.toThrow(/Cycle detected/);
});

test("cross-run singleton race: same instance, single createInstance call", async () => {
  let constructed = 0;
  class Slow {
    static async createInstance() {
      constructed++;
      await new Promise((r) => setTimeout(r, 10));
      return new Slow();
    }
  }
  const di = new Snabditel();
  const [a, b] = await Promise.all([
    di.run((s) => s.resolve(Slow)),
    di.run((s) => s.resolve(Slow)),
  ]);
  expect(a).toBe(b);
  expect(constructed).toBe(1);
});

test("transient scope rebuilt per resolve, scoped deps shared in same run", async () => {
  let apiBuilds = 0;
  class AuthToken {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new AuthToken(); }
    value = Math.random();
  }
  class Api {
    static readonly injectionScope = "transient" as const;
    static async createInstance(s: ASnabditel) {
      apiBuilds++;
      return new Api(await s.resolve(AuthToken));
    }
    constructor(public auth: AuthToken) {}
  }
  const di = new Snabditel();
  await di.run(async (s) => {
    const a1 = await s.resolve(Api);
    const a2 = await s.resolve(Api);
    expect(a1).not.toBe(a2);
    expect(a1.auth).toBe(a2.auth);
  });
  expect(apiBuilds).toBe(2);
});

test("nested run: scope reset, frame inherited (cycle survives)", async () => {
  class A {
    static async createInstance(s: ASnabditel) {
      // Schedule an inner run that re-asks for A — should detect cycle.
      return s.run(async (s2) => {
        await s2.resolve(A);
        return new A();
      });
    }
  }
  const di = new Snabditel();
  await expect(di.resolve(A)).rejects.toThrow(/Cycle detected/);
});

test("captured s after run() end keeps using the captured scope map", async () => {
  class RequestId {
    static readonly injectionScope = "scoped" as const;
    static createInstance() { return new RequestId(); }
    id = Math.random();
  }
  const di = new Snabditel();
  let captured!: ASnabditel;
  const inside = await di.run(async (s) => {
    captured = s;
    return s.resolve(RequestId);
  });
  const after = await captured.resolve(RequestId);
  expect(after).toBe(inside);
});
```

Also add the import for `ASnabditel` near the top of the file:

```ts
import type { ASnabditel, SelfResolvable } from "./snabditel.types";
```

(replace the existing single-import line `import type { SelfResolvable } from "./snabditel.types";` with the line above).

- [ ] **Step 2: Run the new tests**

Run: `bun test src/snabditel.test.ts`
Expected: PASS for all cases.

- [ ] **Step 3: Commit**

```bash
git add src/snabditel.test.ts
git commit -m "$(cat <<'EOF'
test(snabditel): cover inheritance, validation, cycle, race, propagation

Black-box cases ported from als.test.ts plus new browser-safe scenarios
(parallel runs, cross-run singleton race, transient-with-scoped-deps,
nested-run frame inheritance, captured-s after run end).
EOF
)"
```

---

## Task 5: Slim `AlsSnabditel` to a 10-line subclass

**Files:**
- Modify: `src/als.ts`

Delete the entire current implementation. Replace with a subclass that overrides only the two `protected` hooks. ALS-specific tests in `als.test.ts` continue to pass because all engine behavior lives in the base class.

- [ ] **Step 1: Replace `src/als.ts`**

Replace whole file contents with:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { Snabditel, EMPTY_CTX, type Ctx } from "./snabditel";

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

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: PASS for the entire suite — `als.test.ts` cases continue to pass because base now provides the full engine and ALS only adds context propagation.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Verify ALS variant still uses node:async_hooks only in als.ts**

Run: `grep -n async_hooks src/snabditel.ts || echo "OK - clean"`
Expected: `OK - clean`.

Run: `grep -n async_hooks src/als.ts`
Expected: a single import line referencing `node:async_hooks`.

- [ ] **Step 5: Commit**

```bash
git add src/als.ts
git commit -m "$(cat <<'EOF'
refactor(als): slim AlsSnabditel to two-hook subclass over base engine

All resolution logic now lives in the closure-based base. AlsSnabditel
overrides only outerCtx() (returns AsyncLocalStorage store) and
wrapAsync(ctx, fn) (wraps fn in ctxAls.run). Drops ~250 lines of
duplicated engine + helpers.
EOF
)"
```

---

## Task 6: Slim `als.test.ts` to ALS-specific propagation cases

**Files:**
- Modify: `src/als.test.ts`

Cases that exercise model-level behavior (cycle detection, scope inheritance, validation, scoped placement) now have homes in `snabditel.test.ts`. Keep only what specifically proves ALS implicit propagation: `createInstance` and resolves working without using the `s` arg, parallel runs without explicit `s` threading, scoped seeds reading the ALS-current scope.

- [ ] **Step 1: Replace `src/als.test.ts`**

Replace whole file contents with:

```ts
import { describe, expect, test } from "bun:test";
import { AlsSnabditel } from "./als";
import type { SelfResolvable } from "./snabditel.types";

describe("AlsSnabditel — implicit propagation", () => {
  test("createInstance can use module-level di.resolve without s arg", async () => {
    const di = new AlsSnabditel();
    class Logger {}
    class Service {
      // Note: no s arg — relies on ALS implicit propagation.
      static async createInstance() {
        return new Service(await di.resolve(Logger));
      }
      constructor(public logger: Logger) {}
    }
    await di.run(async () => {
      const a = await di.resolve(Service);
      expect(a).toBeInstanceOf(Service);
      expect(a.logger).toBeInstanceOf(Logger);
    });
  });

  test("parallel runs isolated without explicit s threading", async () => {
    const di = new AlsSnabditel();
    const r: SelfResolvable<{ id: number }> = {
      createInstance: () => ({ id: Math.random() }),
      injectionScope: "scoped",
    };
    const work = (delay: number) =>
      di.run(async () => {
        const a = await di.resolve(r);
        await new Promise((res) => setTimeout(res, delay));
        const b = await di.resolve(r);
        expect(a).toBe(b);
        return a;
      });
    const [r1, r2] = await Promise.all([work(20), work(5)]);
    expect(r1).not.toBe(r2);
  });

  test("scoped seed via di.seed reads ALS-current scope", async () => {
    const di = new AlsSnabditel();
    let inside1: number | null = null;
    let inside2: number | null = null;
    await di.run(async () => {
      di.seed("REQ", 1, { injectionScope: "scoped" });
      inside1 = await di.resolve<number>("REQ");
    });
    await di.run(async () => {
      di.seed("REQ", 2, { injectionScope: "scoped" });
      inside2 = await di.resolve<number>("REQ");
    });
    expect(inside1).toBe(1);
    expect(inside2).toBe(2);
    await expect(di.resolve("REQ")).rejects.toThrow(/Unknown token/);
  });

  test("scoped seed outside run() throws", async () => {
    const di = new AlsSnabditel();
    expect(() =>
      di.seed("REQ", 1, { injectionScope: "scoped" }),
    ).toThrow(/Scoped seed requires an active run\(\) scope/);
  });

  test("cycle detection works without s arg threading", async () => {
    const di = new AlsSnabditel();
    class A {
      static async createInstance() {
        await di.resolve(B);
        return new A();
      }
    }
    class B {
      static async createInstance() {
        await di.resolve(A);
        return new B();
      }
    }
    await expect(di.resolve(A)).rejects.toThrow(/Cycle detected/);
  });
});
```

- [ ] **Step 2: Run the slimmed suite**

Run: `bun test src/als.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/als.test.ts
git commit -m "$(cat <<'EOF'
test(als): slim suite to ALS-only propagation cases

Engine cases (cycle, validation, scope inheritance, scoped placement,
seed, transient) are covered by snabditel.test.ts. Remaining tests
prove ALS-specific value: implicit s propagation through async work,
parallel runs without explicit threading, di.seed reading ALS scope.
EOF
)"
```

---

## Task 7: Browser-safety static check

**Files:**
- Modify: `src/snabditel.test.ts`

Append a regression test that asserts `src/snabditel.ts` does not import or reference `node:async_hooks` (or the bare module name `async_hooks`).

- [ ] **Step 1: Append the test inside `describe("Snabditel", ...)`**

```ts
test("source does not import node:async_hooks", async () => {
  const source = await Bun.file(`${import.meta.dir}/snabditel.ts`).text();
  expect(source).not.toMatch(/async_hooks/);
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/snabditel.test.ts -t "does not import node:async_hooks"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/snabditel.test.ts
git commit -m "$(cat <<'EOF'
test(snabditel): regression — base must not import node:async_hooks
EOF
)"
```

---

## Task 8: Update `src/types.test-d.ts` for the new `s` flow

**Files:**
- Modify: `src/types.test-d.ts`

Existing examples in this file remain valid: `() => T` is structurally assignable to `(s: ASnabditel) => T`. Add new compile-time examples that exercise the `s`-arg flow (so the new contract is type-checked).

- [ ] **Step 1: Update top-level import in `src/types.test-d.ts`**

Find:

```ts
import type { SelfResolvable } from "./snabditel.types";
```

Replace with:

```ts
import type { ASnabditel, SelfResolvable } from "./snabditel.types";
```

- [ ] **Step 2: Append examples to `src/types.test-d.ts`**

Append the following to the end of the file:

```ts
async function _scopedResolverArg() {
  const di = new Snabditel();
  class AuthToken {
    static readonly injectionScope = "scoped";
    static createInstance() { return new AuthToken(); }
    value = "x";
  }
  class Api {
    static readonly injectionScope = "transient";
    static async createInstance(s: ASnabditel) {
      return new Api(await s.resolve(AuthToken));
    }
    constructor(public auth: AuthToken) {}
  }
  await di.run(async (s) => {
    const a: Api = await s.resolve(Api);
    void a.auth.value;
  });
}

async function _runCallbackReceivesScopedResolver() {
  const di = new Snabditel();
  await di.run(async (s) => {
    const v = await s.resolve<{ x: number }>("X");
    void v.x;
  });
  await new AlsSnabditel().run(async () => {
    // ALS variant lets you ignore s entirely.
  });
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types.test-d.ts
git commit -m "$(cat <<'EOF'
test(types): add compile-time examples for s-arg in createInstance and run cb
EOF
)"
```

---

## Task 9: Update `README.md`

**Files:**
- Modify: `README.md`

Apply the four documentation changes from the spec: tagline, TanStack Start (global request middleware), React + React Query (transient `Api`, browser-safe `run()`), and the API summary block.

- [ ] **Step 1: Update tagline (around line 11)**

Find:

```
- `Snabditel` — single-flight `run()` scope (no concurrent scopes).
- `AlsSnabditel` — `AsyncLocalStorage`-backed scope, safe under parallel `run()` calls.
```

Replace with:

```
- `Snabditel` — explicit-scope `run()`, browser-safe, parallel scopes.
- `AlsSnabditel` — `AsyncLocalStorage`-backed propagation; node-only.
```

- [ ] **Step 2: Replace TanStack Start section (around lines 92–124)**

Find the entire `### TanStack Start` block (from heading through the closing fence of the example, ending at `});`).

Replace with:

````markdown
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
  di.run(() => next()),
);

export const startInstance = createStart(() => ({
  requestMiddleware: [diMiddleware],
}));
```

```ts
// any server route, server function, or loader
import { di, UserService } from "./di";

const users = await di.resolve(UserService);   // sees the request's scope via ALS
```

Use `functionMiddleware` instead of `requestMiddleware` to limit the scope to server-function calls only.
````

- [ ] **Step 3: Replace React + React Query section (around lines 126–194)**

Find the entire `### React + React Query` block, including the closing paragraph that begins `For per-query scoping in the browser, swap to AlsSnabditel...`.

Replace with:

````markdown
### React + React Query

Browser side. Each `queryFn` opens its own `di.run(s => ...)` — concurrent runs are safe in base `Snabditel`. `Api` is `transient` to demonstrate scope propagation; `AuthToken` is `scoped` so all transient `Api` instances inside one query share the same auth view.

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
````

- [ ] **Step 4: Replace Concurrent scopes section (around lines 240–271)**

Find `### Concurrent scopes (`AlsSnabditel`)` (or the section currently titled around concurrent scopes). It contains the `RequestHandler` example that imports from `snabditel/als`.

Replace the heading and example code with:

````markdown
## Concurrent scopes

Both flavors handle parallel `run()` calls. Base `Snabditel` requires the explicit `s` resolver; `AlsSnabditel` propagates it implicitly.

```ts
import { Snabditel, type ASnabditel } from "snabditel";

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

`AlsSnabditel` (subpath `snabditel/als`) extends this with implicit `s` propagation via `node:async_hooks`, so callbacks and `createInstance` can ignore the `s` arg. The subpath is separate so `node:async_hooks` only loads when imported.
````

- [ ] **Step 5: Replace API summary block (around lines 275–283)**

Find:

```ts
class Snabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: () => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() + scope inheritance + validation
```

Replace with:

```ts
class Snabditel implements ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() — s arg optional in practice; same inheritance + validation
```

- [ ] **Step 6: Verify the full README still typechecks**

The README's TS samples are mirrored in `src/types.test-d.ts`. Run:

`bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): browser-safe run(), TanStack Start global middleware, transient Api

Tagline now reflects that base supports parallel scopes. TanStack Start
section uses createStart({ requestMiddleware }) global registration. RQ
example shows transient Api over scoped AuthToken to demonstrate scope
propagation through createInstance(s). API block updated for the new
run callback signature.
EOF
)"
```

---

## Task 10: Final verification

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `bun test`
Expected: ALL PASS, no skipped tests.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Run the build**

Run: `bun run build`
Expected: Successful build into `dist/esm`, `dist/cjs`, `dist/types`.

- [ ] **Step 4: Confirm browser-safety boundary on built output**

Run:

```bash
grep -n async_hooks dist/esm/index.js dist/cjs/index.js || echo "OK - main entry clean"
grep -n async_hooks dist/esm/als-index.js dist/cjs/als-index.js | head
```

Expected:
- First command prints `OK - main entry clean` (the main entry must not pull `node:async_hooks`).
- Second command prints lines from `als-index.js` referencing `async_hooks` (only ALS subpath uses it).

- [ ] **Step 5: Confirm git history**

Run: `git log --oneline -12`
Expected: Commits for tasks 1–9 in order, on the current branch.

No commit needed for this task — verification only.
