# Snabditel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Snabditel` (browser-safe DI engine, parallel-run safe, no `node:async_hooks`) and `AlsSnabditel` (a thin subclass layering `AsyncLocalStorage` for implicit propagation in node). Both share inheritance, validation, cycle detection, and single-flight dedupe via the engine on `Snabditel`.

**Architecture:** `Snabditel` carries `singletons` + a single root-level `inflight` map. `run(cb)` builds a fresh `Ctx = { scope: Map, frame: Frame|null }` and passes a closure-built `s: ASnabditel` to `cb`. Each `s.resolve(token)` calls `resolveIn(token, ctx)`. The builder threads a child `s` (with new frame) into `createInstance(s)`. Two `protected` hooks — `outerCtx()` and `wrapAsync(ctx, fn)` — default to no-ops and let `AlsSnabditel` layer ALS on top with no other code.

**Spec:** `docs/superpowers/specs/snabditel-design.md`.

**Tech stack:** TypeScript, Bun (runtime + test runner + bundler). `node:async_hooks` only inside `src/als.ts`.

**Test discipline:** TDD per task — failing test first, implementation next, suite green at end of task. Tests are committed alongside the code that makes them pass.

---

## File map

```
src/
  snabditel.types.ts    Task 1
  snabditel.ts          Tasks 2–9
  als.ts                Task 10
  als-index.ts          Task 10
  index.ts              Task 1
  snabditel.test.ts     Tasks 2–9 (TDD)
  als.test.ts           Task 10
  types.test-d.ts       Task 11
README.md               Task 13
```

---

## Task 1: public types and entrypoints

**Files:**
- Create / overwrite: `src/snabditel.types.ts`, `src/index.ts`, `src/als-index.ts`.

- [ ] **Step 1.** Write `src/snabditel.types.ts`:

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

- [ ] **Step 2.** Write `src/index.ts`:

```ts
export { Snabditel } from "./snabditel";
export type * from "./snabditel.types";
```

- [ ] **Step 3.** Write `src/als-index.ts`:

```ts
export { AlsSnabditel } from "./als";
```

- [ ] **Step 4.** Verify `package.json` exports map points to `dist/index.js` for the main entry and `dist/als-index.js` for `snabditel/als`.

- [ ] **Step 5.** `bun run typecheck` will fail until `snabditel.ts` and `als.ts` exist — that's fine; it gets resolved in subsequent tasks.

- [ ] **Step 6.** Commit: `feat(types): public Resolvable / Seeder / Scopeable / Resolver`.

---

## Task 2: Snabditel skeleton — types, ctx, hooks

**Files:** `src/snabditel.ts`, `src/snabditel.test.ts`.

The first slice gets the class compiling with empty hook implementations, no resolution yet.

- [ ] **Step 1.** Write a smoke test in `src/snabditel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Snabditel } from "./snabditel";

describe("Snabditel", () => {
  test("can be constructed", () => {
    expect(new Snabditel()).toBeInstanceOf(Snabditel);
  });
});
```

`bun test src/snabditel.test.ts` — FAIL: module not found.

- [ ] **Step 2.** Write the skeleton `src/snabditel.ts`:

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

export type Ctx = { scope: Scope | null; frame: Frame | null };

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

  resolve<T>(_token: Token<T>): Promise<T> {
    throw new Error("not implemented");
  }

  seed<T>(
    _token: string | symbol | (new (...args: any[]) => T),
    _value: T,
    _options: SeedOptions = {},
  ): void {
    throw new Error("not implemented");
  }

  async run<T>(_cb: (s: ASnabditel) => Promise<T>): Promise<T> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 3.** `bun test src/snabditel.test.ts` — PASS (smoke test).
- [ ] **Step 4.** `bun run typecheck` — clean.
- [ ] **Step 5.** Commit: `feat(snabditel): skeleton — types, ctx, hooks`.

---

## Task 3: seed + run plumbing + makeScoped

Add `seedInto`, `seed`, `run`, and `makeScoped`. No `resolve` yet.

- [ ] **Step 1.** Append failing tests:

```ts
test("seed pre-populates string token (singleton) and resolves outside run", async () => {
  const s = new Snabditel();
  s.seed("CFG", { url: "x" });
  // resolve still throws — covered in next task
});

test("scoped seed outside run throws", () => {
  const s = new Snabditel();
  expect(() => s.seed("REQ", {}, { injectionScope: "scoped" })).toThrow(
    /run\(\) scope/,
  );
});

test("transient seed throws", () => {
  const s = new Snabditel();
  expect(() => s.seed("X", {}, { injectionScope: "transient" })).toThrow(
    /transient/,
  );
});

test("run() calls callback with a scope-bound resolver", async () => {
  const s = new Snabditel();
  let received: unknown = null;
  await s.run(async (sc) => {
    received = sc;
  });
  expect(received).not.toBeNull();
  expect(typeof (received as ASnabditel).resolve).toBe("function");
  expect(typeof (received as ASnabditel).seed).toBe("function");
  expect(typeof (received as ASnabditel).run).toBe("function");
});
```

(Add `import type { ASnabditel } from "./snabditel.types";` if not already there.)

- [ ] **Step 2.** Implement in `src/snabditel.ts`:

```ts
seed<T>(token, value, options: SeedOptions = {}): void {
  return this.seedInto(this.outerCtx().scope, token, value, options);
}

private seedInto<T>(
  scope: Scope | null,
  token: string | symbol | (new (...args: any[]) => T),
  value: T,
  options: SeedOptions,
): void {
  const which = options.injectionScope ?? "singleton";
  if (which === "singleton") { this.singletons.set(token, value); return; }
  if (which === "scoped") {
    if (!scope) throw new Error("Scoped seed requires an active run() scope");
    scope.set(token, value);
    return;
  }
  throw new Error("Cannot seed a transient value");
}

async run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> {
  const outer = this.outerCtx();
  const ctx: Ctx = { scope: new Map(), frame: outer.frame };
  return this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
}

private makeScoped(ctx: Ctx): ASnabditel {
  return {
    resolve: <T>(token: Token<T>): Promise<T> => this.resolveIn(token, ctx),

    seed: <T>(token, value, options: SeedOptions = {}): void =>
      this.seedInto(ctx.scope, token, value, options),

    run: <T>(cb: (s: ASnabditel) => Promise<T>): Promise<T> => {
      const child: Ctx = { scope: new Map(), frame: ctx.frame };
      return this.wrapAsync(child, () => cb(this.makeScoped(child)));
    },
  };
}
```

`makeScoped.resolve` references `this.resolveIn` — declared in the next task as a stub that throws.

Add the stub:

```ts
protected resolveIn<T>(_token: Token<T>, _ctx: Ctx): Promise<T> {
  throw new Error("not implemented");
}
```

- [ ] **Step 3.** `bun test src/snabditel.test.ts -t "seed|run\\(\\)"` — PASS.
- [ ] **Step 4.** Commit: `feat(snabditel): seed + run plumbing, makeScoped factory`.

---

## Task 4: resolveIn — string/symbol path

Wire `readSeedAndBubble` and bubble. `bubble` for now is a no-op when no frame is active; full implementation in Task 7.

- [ ] **Step 1.** Append failing tests:

```ts
test("seed pre-populates string token", async () => {
  const s = new Snabditel();
  s.seed("CFG", { url: "x" });
  const got = await s.resolve<{ url: string }>("CFG");
  expect(got.url).toBe("x");
});

test("seed pre-populates symbol token", async () => {
  const s = new Snabditel();
  const TOK = Symbol("tok");
  s.seed(TOK, 42);
  expect(await s.resolve<number>(TOK)).toBe(42);
});

test("scoped seed shadows singleton seed in run", async () => {
  const s = new Snabditel();
  s.seed("LOG", "global");
  let inside: string | null = null;
  await s.run(async (sc) => {
    sc.seed("LOG", "request", { injectionScope: "scoped" });
    inside = await sc.resolve<string>("LOG");
  });
  const outside = await s.resolve<string>("LOG");
  expect(inside).toBe("request");
  expect(outside).toBe("global");
});

test("unknown string token throws", async () => {
  const s = new Snabditel();
  await expect(s.resolve("MISSING")).rejects.toThrow(/Unknown token/);
});
```

- [ ] **Step 2.** Add the public `resolve` and the dispatcher:

```ts
resolve<T>(token: Token<T>): Promise<T> {
  return this.resolveIn(token, this.outerCtx());
}

protected resolveIn<T>(token: Token<T>, ctx: Ctx): Promise<T> {
  if (typeof token === "string" || typeof token === "symbol") {
    return this.readSeedAndBubble<T>(token, ctx);
  }
  // remaining branches added in later tasks
  throw new Error("not implemented");
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

private bubble(_scope: InjectionScope, _frame: Frame | null): void {
  // full implementation in Task 7
}
```

- [ ] **Step 3.** Tests in this task PASS.
- [ ] **Step 4.** Commit: `feat(snabditel): resolveIn dispatcher + string/symbol path`.

---

## Task 5: builder + build + placeIntoCache

Resolve `Resolvable<T>` for explicit `singleton` / `scoped` / `transient`. `inflight` is registered but no waiter dispatch yet — concurrent races are covered in Task 9.

- [ ] **Step 1.** Append failing tests:

```ts
test("resolve(Class) instantiates and caches as singleton by default", async () => {
  class Foo {}
  const s = new Snabditel();
  const a = await s.resolve(Foo);
  const b = await s.resolve(Foo);
  expect(a).toBeInstanceOf(Foo);
  expect(a).toBe(b);
});

test("transient scope returns new instance each time", async () => {
  const r: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new Snabditel();
  const [a, b] = [await s.resolve(r), await s.resolve(r)];
  expect(a).not.toBe(b);
});

test("scoped: same instance within run, different across runs", async () => {
  const r: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new Snabditel();
  let a1: object | null = null, a2: object | null = null;
  await s.run(async (sc) => {
    a1 = await sc.resolve(r);
    a2 = await sc.resolve(r);
  });
  let b: object | null = null;
  await s.run(async (sc) => { b = await sc.resolve(r); });
  expect(a1).toBe(a2);
  expect(a1).not.toBe(b);
});

test("scoped resolve outside run throws", async () => {
  const r: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new Snabditel();
  await expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
});

test("SelfResolvable.createInstance is awaited", async () => {
  const r: SelfResolvable<{ n: number }> = {
    createInstance: async () => ({ n: 7 }),
  };
  const s = new Snabditel();
  expect((await s.resolve(r)).n).toBe(7);
});
```

- [ ] **Step 2.** Extend `resolveIn` and add builder + build + placeIntoCache:

```ts
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

  // inflight + waiter added in Task 9
  return this.builder(token, ctx);
}

private async builder<T>(token: Resolvable<T>, ctx: Ctx): Promise<T> {
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

    const effective: InjectionScope = declared ?? frame.minScope;
    const builtInScope = ctx.scope;

    this.placeIntoCache(token, value, effective, builtInScope, declared);
    this.bubble(effective, ctx.frame);

    resolveSettled({ value, effectiveScope: effective, builtInScope });
    return value;
  } catch (e) {
    rejectSettled(e);
    throw e;
  } finally {
    this.inflight.delete(token);
  }
}

private async build<T>(token: Resolvable<T>, s: ASnabditel): Promise<T> {
  if ("createInstance" in token) return await token.createInstance(s);
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

private scopeOf<T>(_binding: Resolvable<T>): InjectionScope | undefined {
  return undefined; // Task 6 implementation
}

private effectiveScopedNoRunError<T>(_binding: Resolvable<T>): Error {
  return new Error("scoped no-run"); // Task 6 implementation
}
```

- [ ] **Step 3.** Tests added here PASS.
- [ ] **Step 4.** Commit: `feat(snabditel): builder + build + placeIntoCache`.

---

## Task 6: helpers — narrower / isWider / scopeOf / ownerName / errors

- [ ] **Step 1.** Replace the placeholders with real implementations:

```ts
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
```

- [ ] **Step 2.** Existing tests still PASS. No new tests in this task — helpers are exercised by Tasks 7–9.
- [ ] **Step 3.** Commit: `feat(snabditel): scope helpers + error builders`.

---

## Task 7: scope inheritance + validation via bubble

- [ ] **Step 1.** Append failing tests:

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
  const a = await di.run(async (s) => (await s.resolve(UserService)).req);
  const b = await di.run(async (s) => (await s.resolve(UserService)).req);
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
```

- [ ] **Step 2.** Replace `bubble` with the real implementation:

```ts
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
```

Add the post-build validation guard inside `builder` (after `await wrapAsync`, before `placeIntoCache`):

```ts
if (declared !== undefined && this.isWider(declared, frame.minScope)) {
  throw this.mismatchError(token, declared, frame.minScope);
}
```

- [ ] **Step 3.** Tests in this task PASS. Existing tests stay green.
- [ ] **Step 4.** Commit: `feat(snabditel): scope inheritance + validation`.

---

## Task 8: cycle detection

- [ ] **Step 1.** Append failing tests:

```ts
test("cycle detection via parent frame chain", async () => {
  class A {
    static async createInstance(s: ASnabditel) { await s.resolve(B); return new A(); }
  }
  class B {
    static async createInstance(s: ASnabditel) { await s.resolve(A); return new B(); }
  }
  const di = new Snabditel();
  await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
});

test("nested run: scope reset, frame inherited (cycle survives)", async () => {
  class A {
    static async createInstance(s: ASnabditel) {
      return s.run(async (s2) => { await s2.resolve(A); return new A(); });
    }
  }
  const di = new Snabditel();
  await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
});
```

The cast to `Promise<void>` works around TS-LS issue 80007 with class-recursive `createInstance` types confusing `expect.rejects.toThrow` overload resolution; tsgo accepts the original form, the cast is safe.

- [ ] **Step 2.** Add `assertNoCycle` and call it from `builder`:

```ts
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
```

In `builder`, add `this.assertNoCycle(token, ctx.frame)` as the first line.

- [ ] **Step 3.** Tests PASS.
- [ ] **Step 4.** Commit: `feat(snabditel): cycle detection via frame parent chain`.

---

## Task 9: single-flight inflight + waiter dispatch

- [ ] **Step 1.** Append failing tests:

```ts
test("single-flight: concurrent resolves of same singleton", async () => {
  let calls = 0;
  const r: SelfResolvable<{ id: number }> = {
    createInstance: async () => {
      calls++;
      await new Promise((res) => setTimeout(res, 10));
      return { id: calls };
    },
  };
  const s = new Snabditel();
  const [a, b, c] = await Promise.all([s.resolve(r), s.resolve(r), s.resolve(r)]);
  expect(a).toBe(b); expect(b).toBe(c); expect(calls).toBe(1);
});

test("cross-run singleton race: same instance, single createInstance", async () => {
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
  expect(a).toBe(b); expect(constructed).toBe(1);
});

test("singleton retries after createInstance failure (cache evicted on reject)", async () => {
  let calls = 0;
  const r: SelfResolvable<{ ok: boolean }> = {
    createInstance: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { ok: true };
    },
  };
  const s = new Snabditel();
  await expect(s.resolve(r)).rejects.toThrow(/boom/);
  expect((await s.resolve(r)).ok).toBe(true);
  expect(calls).toBe(2);
});

test("concurrent resolves with overlapping shared dep do not false-positive cycle", async () => {
  const di = new Snabditel();
  const Shared: SelfResolvable<{ shared: true }> = {
    createInstance: async () => {
      await new Promise((res) => setTimeout(res, 10));
      return { shared: true };
    },
  };
  const A: SelfResolvable<{ a: true }> = {
    createInstance: async (s) => { await s.resolve(Shared); return { a: true }; },
  };
  const B: SelfResolvable<{ b: true }> = {
    createInstance: async (s) => { await s.resolve(Shared); return { b: true }; },
  };
  await Promise.all([di.resolve(A), di.resolve(B)]);
});
```

- [ ] **Step 2.** Add the `inflight` consult to `resolveIn` (between scope-hit and builder):

```ts
const pending = this.inflight.get(token);
if (pending) {
  this.assertNoCycle(token, ctx.frame);
  return this.waiter(token, pending as Promise<BuildResult<T>>, ctx);
}
return this.builder(token, ctx);
```

Implement `waiter`:

```ts
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
```

- [ ] **Step 3.** Tests PASS.
- [ ] **Step 4.** Commit: `feat(snabditel): single-flight inflight + waiter dispatch`.

---

## Task 10: AlsSnabditel adapter

**Files:** `src/als.ts`, `src/als.test.ts`.

- [ ] **Step 1.** Write `src/als.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AlsSnabditel } from "./als";
import type { SelfResolvable } from "./snabditel.types";

describe("AlsSnabditel — implicit propagation", () => {
  test("createInstance can use module-level di.resolve without s arg", async () => {
    const di = new AlsSnabditel();
    class Logger {}
    class Service {
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
    const inside1 = await di.run(async () => {
      di.seed("REQ", 1, { injectionScope: "scoped" });
      return di.resolve<number>("REQ");
    });
    const inside2 = await di.run(async () => {
      di.seed("REQ", 2, { injectionScope: "scoped" });
      return di.resolve<number>("REQ");
    });
    expect(inside1).toBe(1);
    expect(inside2).toBe(2);
    await expect(di.resolve("REQ")).rejects.toThrow(/Unknown token/);
  });

  test("scoped seed outside run() throws", () => {
    const di = new AlsSnabditel();
    expect(() => di.seed("REQ", 1, { injectionScope: "scoped" }))
      .toThrow(/Scoped seed requires an active run\(\) scope/);
  });

  test("cycle detection works without s arg threading", async () => {
    const di = new AlsSnabditel();
    class A {
      static async createInstance() { await di.resolve(B); return new A(); }
    }
    class B {
      static async createInstance() { await di.resolve(A); return new B(); }
    }
    await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
  });
});
```

- [ ] **Step 2.** Write `src/als.ts`:

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

- [ ] **Step 3.** `bun test src/als.test.ts` — PASS.
- [ ] **Step 4.** **Static check** — add to `src/snabditel.test.ts`:

```ts
test("source does not import node:async_hooks", async () => {
  const source = await Bun.file(`${import.meta.dir}/snabditel.ts`).text();
  expect(source).not.toMatch(/async_hooks/);
});
```

PASS.

- [ ] **Step 5.** Commit: `feat(als): AlsSnabditel adapter — outerCtx + wrapAsync hooks`.

---

## Task 11: type tests

**Files:** `src/types.test-d.ts`.

- [ ] **Step 1.** Write compile-time examples covering:

  - `SelfResolvable<T>.createInstance(s: ASnabditel)` — both as a class static method and as an object literal.
  - `SelfResolvable<T>.createInstance` may be `() => T` (structural assignability — a no-arg createInstance assigns to the `(s) => T` slot).
  - `Scopeable.run((s) => Promise<T>)` callback shape.
  - `seed` with string, symbol, and class tokens.
  - Both shapes typecheck under `Snabditel` and `AlsSnabditel`.

- [ ] **Step 2.** `bun run typecheck` — clean.
- [ ] **Step 3.** Commit: `test(types): compile-time examples for s arg`.

---

## Task 12: full sweep — typecheck, build, all suites

- [ ] **Step 1.** `bun run typecheck` — clean.
- [ ] **Step 2.** `bun test` — all tests across `snabditel.test.ts`, `als.test.ts`, `types.test-d.ts` PASS.
- [ ] **Step 3.** `bun run build` — succeeds. Confirm `dist/` contains `index.js`, `als-index.js`, and matching `.d.ts` files.
- [ ] **Step 4.** Smoke-import the built artefact in a tiny scratch file to confirm both subpaths resolve:

```ts
import { Snabditel } from "snabditel";
import { AlsSnabditel } from "snabditel/als";
new Snabditel(); new AlsSnabditel();
```

- [ ] **Step 5.** Commit if any incidental fixes were made; otherwise skip.

---

## Task 13: README updates

**Files:** `README.md`.

- [ ] **Step 1.** Tagline: clarify the two flavors.

```markdown
- `Snabditel` — explicit-scope `run()`, browser-safe, parallel scopes.
- `AlsSnabditel` — `AsyncLocalStorage`-backed propagation; node-only.
```

- [ ] **Step 2.** Concurrent-scopes section uses base `Snabditel`:

```ts
import { Snabditel } from "snabditel";
import type { ASnabditel } from "snabditel";

const di = new Snabditel();

class RequestHandler {
  static async createInstance(s: ASnabditel) {
    return new RequestHandler(await s.resolve(Logger));
  }
  constructor(private logger: Logger) {}
  async handle(req: Request) { /* ... */ }
}

await Promise.all([
  di.run(async (s) => (await s.resolve(RequestHandler)).handle(req1)),
  di.run(async (s) => (await s.resolve(RequestHandler)).handle(req2)),
]);
```

- [ ] **Step 3.** TanStack Start: register the DI scope as **global request middleware**. ALS propagates `s` implicitly.

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

- [ ] **Step 4.** React + React Query: each `queryFn` opens its own `di.run(s => ...)`. `Api` is `transient` to demonstrate scope propagation; `AuthToken` is `scoped` so transients in one query share the same auth view.

  (Full code in spec § "ALS adapter" / README "React + React Query" section.)

- [ ] **Step 5.** API summary block:

```ts
class Snabditel implements ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token, value, options?): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
}

class AlsSnabditel extends Snabditel {
  // ALS-backed propagation: s arg optional in practice
}
```

- [ ] **Step 6.** Commit: `docs(readme): browser-safe Snabditel + ALS adapter`.

---

## Self-review

**Goal coverage:**

- Goal 1 — parallel `run()`: Tasks 3 (closure-based ctx) + 9 (concurrent dedupe) + tests in Task 10.
- Goal 2 — browser-safe core: Task 10 static check + import guard.
- Goal 3 — scope inheritance: Task 7.
- Goal 4 — lifetime validation: Task 7 (bubble + post-build check).
- Goal 5 — single-flight dedupe: Task 9.
- Goal 6 — cycle detection: Task 8.
- Goal 7 — ALS adapter: Task 10.

**Type / signature consistency:** `Frame`, `Ctx`, `BuildResult`, `Scope`, `RANK`, `EMPTY_CTX` — defined once in `src/snabditel.ts`, re-imported by `src/als.ts`. `Frame`, `Ctx`, `EMPTY_CTX` are exported for the subclass; `BuildResult` and `Scope` stay module-private.

**Risk: behavior drift across tasks.** Mitigation — TDD per task, full suite green at end of each task. The static "no `async_hooks`" assertion guards browser safety from Task 10 onward.

**Risk: TS-LS confusion on class-recursive `createInstance` types.** Cycle tests use a documented `as unknown as Promise<void>` cast. tsgo accepts the original form.

---

## Notes for the implementer

- `EMPTY_CTX` must be a frozen module-level singleton. Allocating fresh `{ scope: null, frame: null }` per `outerCtx()` call is wrong — measurable allocation churn on the no-run path.
- The `inflight` `Map` is keyed by token (not by `(token, ctx)`). A single root-level lock is intentional: cross-run racing of an unset → singleton token converges to one build; cross-run racing of an unset → scoped token uses the waiter restart path.
- `pending.catch(() => undefined)` in `builder` is required: the pending promise is registered before any awaiter attaches, and a synchronous reject without a catch handler triggers Bun's unhandled-rejection diagnostic.
- `bubble` throws synchronously inside `wrapAsync`'s callback during `createInstance` — that propagates as a rejected promise from the `await` site, which is what aborts `createInstance` early.
- The waiter restart path uses a tail call `return this.resolveIn(token, ctx)`. JavaScript does not implement TCO but this is bounded: by the time a waiter restarts, the original builder's `finally` has cleared `inflight`, so the restarter either becomes the new builder or finds a fresh in-flight and waits on it.
- Do not add `src/internal/`. Helpers live as `private` methods on the class that uses them. The single helper file would resurrect the indirection cost (callbacks, extra args) that the class-private form avoids.
- `node:async_hooks` is imported only in `src/als.ts`. The static assertion in `snabditel.test.ts` enforces this.
