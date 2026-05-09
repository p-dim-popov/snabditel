# AlsSnabditel Scope Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AlsSnabditel` infer narrowest dep scope when `injectionScope` unset, and throw a clear error when declared scope is wider than its narrowest dependency. Base `Snabditel` unchanged.

**Architecture:** `AlsSnabditel` becomes standalone (no `extends Snabditel`). Two `AsyncLocalStorage` instances — one for run scope, one for a per-build "frame" that records the narrowest dep scope encountered. An `inFlight` `Map` provides single-flight dedupe; waiters dispatch on the builder's resolved effective scope (singleton → adopt; scoped/transient → restart). Cycle detection comes free by walking the frame parent chain.

**Tech Stack:** TypeScript / Bun, `node:async_hooks` (only via `AlsSnabditel` — base must not import it).

**Spec:** `docs/superpowers/specs/2026-05-09-scope-inheritance-design.md`

**Test runner:** `bun test src/als.test.ts` (single file).

---

## File Structure

- `src/internal/scope-helpers.ts` (new) — pure helpers: `narrower(a, b)`, `isWider(declared, min)`, `scopeOf(token)`, `ownerName(token)`, mismatch / scoped-no-run error builders.
- `src/internal/seed-helpers.ts` (new) — pure helpers: `writeSeed(singletons, getScope, token, value, options)`, `readSeedToken(singletons, currentScope, token)`. Used by `AlsSnabditel`. (`Snabditel` may adopt later but is out of scope here.)
- `src/als.ts` — rewritten. No `extends Snabditel`. Implements `ASnabditel` directly with the new internals.
- `src/snabditel.ts` — unchanged.
- `src/snabditel.types.ts` — unchanged externally.
- `src/als.test.ts` — extended with the new behavior tests (preserve all existing tests).

---

## Task 1: scope helpers

**Files:**
- Create: `src/internal/scope-helpers.ts`
- Test: `src/internal/scope-helpers.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/internal/scope-helpers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  narrower,
  isWider,
  scopeOf,
  ownerName,
} from "./scope-helpers";

describe("narrower", () => {
  test("returns the narrower of two scopes (lifetime ordering)", () => {
    expect(narrower("singleton", "singleton")).toBe("singleton");
    expect(narrower("singleton", "scoped")).toBe("scoped");
    expect(narrower("scoped", "singleton")).toBe("scoped");
    expect(narrower("scoped", "scoped")).toBe("scoped");
    expect(narrower("scoped", "transient")).toBe("transient");
    expect(narrower("transient", "scoped")).toBe("transient");
    expect(narrower("transient", "transient")).toBe("transient");
    expect(narrower("singleton", "transient")).toBe("transient");
  });
});

describe("isWider", () => {
  test("true when declared lifetime is longer than min", () => {
    expect(isWider("singleton", "scoped")).toBe(true);
    expect(isWider("singleton", "transient")).toBe(true);
    expect(isWider("scoped", "transient")).toBe(true);
  });
  test("false when declared <= min", () => {
    expect(isWider("singleton", "singleton")).toBe(false);
    expect(isWider("scoped", "scoped")).toBe(false);
    expect(isWider("scoped", "singleton")).toBe(false);
    expect(isWider("transient", "singleton")).toBe(false);
    expect(isWider("transient", "scoped")).toBe(false);
    expect(isWider("transient", "transient")).toBe(false);
  });
});

describe("scopeOf", () => {
  test("returns explicit injectionScope from SelfResolvable", () => {
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "scoped" })).toBe("scoped");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "transient" })).toBe("transient");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "singleton" })).toBe("singleton");
  });
  test("returns undefined when SelfResolvable has no injectionScope", () => {
    expect(scopeOf({ createInstance: () => ({}) })).toBeUndefined();
  });
  test("returns explicit injectionScope from class with static field", () => {
    class Foo { static readonly injectionScope = "scoped" as const; }
    expect(scopeOf(Foo)).toBe("scoped");
  });
  test("returns undefined for plain class without injectionScope", () => {
    class Bar {}
    expect(scopeOf(Bar)).toBeUndefined();
  });
});

describe("ownerName", () => {
  test("named class -> class name", () => {
    class Foo {}
    expect(ownerName(Foo)).toBe("Foo");
  });
  test("anonymous class -> 'anonymous class'", () => {
    const Anon = class {};
    Object.defineProperty(Anon, "name", { value: "" });
    expect(ownerName(Anon)).toBe("anonymous class");
  });
  test("SelfResolvable object literal -> 'anonymous SelfResolvable'", () => {
    expect(ownerName({ createInstance: () => ({}) })).toBe("anonymous SelfResolvable");
  });
});
```

- [ ] **Step 2: Run test, verify fails**

Run: `bun test src/internal/scope-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

Create `src/internal/scope-helpers.ts`:

```ts
import type {
  InjectionScope,
  Resolvable,
  SelfResolvable,
} from "../snabditel.types";

const RANK: Record<InjectionScope, number> = {
  transient: 0,
  scoped: 1,
  singleton: 2,
};

export function narrower(a: InjectionScope, b: InjectionScope): InjectionScope {
  return RANK[a] <= RANK[b] ? a : b;
}

export function isWider(
  declared: InjectionScope,
  min: InjectionScope,
): boolean {
  return RANK[declared] > RANK[min];
}

export function scopeOf<T>(
  binding: Resolvable<T>,
): InjectionScope | undefined {
  if ("injectionScope" in binding && binding.injectionScope !== undefined) {
    return binding.injectionScope;
  }
  return undefined;
}

export function ownerName<T>(binding: Resolvable<T>): string {
  if (typeof binding === "function") {
    return binding.name && binding.name.length > 0
      ? binding.name
      : "anonymous class";
  }
  const ctor = (binding as SelfResolvable<T>).constructor;
  if (ctor && ctor.name && ctor.name !== "Object") {
    return ctor.name;
  }
  return "anonymous SelfResolvable";
}

export function mismatchError<T>(
  binding: Resolvable<T>,
  declared: InjectionScope,
  min: InjectionScope,
): Error {
  return new Error(
    `Cannot resolve ${ownerName(binding)} as ${declared}: depends on a ${min} service. ` +
      `Either remove \`injectionScope\` to inherit '${min}', or set it to '${min}' or 'transient'.`,
  );
}

export function effectiveScopedNoRunError<T>(
  binding: Resolvable<T>,
): Error {
  return new Error(
    `${ownerName(binding)} effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.`,
  );
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/internal/scope-helpers.test.ts`
Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/internal/scope-helpers.ts src/internal/scope-helpers.test.ts
git commit -m "feat: add scope helpers (narrower, isWider, scopeOf, ownerName)"
```

---

## Task 2: seed helpers

**Files:**
- Create: `src/internal/seed-helpers.ts`
- Test: `src/internal/seed-helpers.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/internal/seed-helpers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { writeSeed, readSeedToken } from "./seed-helpers";

describe("writeSeed", () => {
  test("default singleton -> writes to singletons map", () => {
    const singletons = new Map<unknown, unknown>();
    writeSeed(singletons, () => null, "K", 1);
    expect(singletons.get("K")).toBe(1);
  });

  test("explicit singleton -> writes to singletons map", () => {
    const singletons = new Map<unknown, unknown>();
    writeSeed(singletons, () => null, "K", 1, { injectionScope: "singleton" });
    expect(singletons.get("K")).toBe(1);
  });

  test("scoped + active scope -> writes to scope map", () => {
    const singletons = new Map<unknown, unknown>();
    const scope = new Map<unknown, unknown>();
    writeSeed(singletons, () => scope, "K", 1, { injectionScope: "scoped" });
    expect(scope.get("K")).toBe(1);
    expect(singletons.has("K")).toBe(false);
  });

  test("scoped + no scope -> throws", () => {
    expect(() =>
      writeSeed(new Map(), () => null, "K", 1, { injectionScope: "scoped" }),
    ).toThrow(/run\(\) scope/);
  });

  test("transient -> throws", () => {
    expect(() =>
      writeSeed(new Map(), () => null, "K", 1, { injectionScope: "transient" }),
    ).toThrow(/transient/);
  });
});

describe("readSeedToken", () => {
  test("scope hit returns value + 'scoped'", async () => {
    const singletons = new Map<unknown, unknown>();
    const scope = new Map<unknown, unknown>([["K", 9]]);
    const r = await readSeedToken(singletons, scope, "K");
    expect(r).toEqual({ value: 9, source: "scoped" });
  });

  test("singleton hit returns value + 'singleton'", async () => {
    const singletons = new Map<unknown, unknown>([["K", 7]]);
    const r = await readSeedToken(singletons, null, "K");
    expect(r).toEqual({ value: 7, source: "singleton" });
  });

  test("scope hit shadows singleton", async () => {
    const singletons = new Map<unknown, unknown>([["K", 1]]);
    const scope = new Map<unknown, unknown>([["K", 2]]);
    const r = await readSeedToken(singletons, scope, "K");
    expect(r).toEqual({ value: 2, source: "scoped" });
  });

  test("miss throws Unknown token", async () => {
    await expect(readSeedToken(new Map(), null, "MISSING")).rejects.toThrow(
      /Unknown token/,
    );
  });

  test("awaits cached promise values", async () => {
    const singletons = new Map<unknown, unknown>([["K", Promise.resolve(42)]]);
    const r = await readSeedToken(singletons, null, "K");
    expect(r).toEqual({ value: 42, source: "singleton" });
  });
});
```

- [ ] **Step 2: Run test, verify fails**

Run: `bun test src/internal/seed-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

Create `src/internal/seed-helpers.ts`:

```ts
import type { SeedOptions } from "../snabditel.types";

export type Scope = Map<unknown, unknown>;
export type SeedSource = "singleton" | "scoped";

export function writeSeed<T>(
  singletons: Scope,
  getScope: () => Scope | null,
  token: string | symbol | (new (...args: any[]) => T),
  value: T,
  options: SeedOptions = {},
): void {
  const injectionScope = options.injectionScope ?? "singleton";
  if (injectionScope === "singleton") {
    singletons.set(token, value);
    return;
  }
  if (injectionScope === "scoped") {
    const scope = getScope();
    if (!scope) {
      throw new Error("Scoped seed requires an active run() scope");
    }
    scope.set(token, value);
    return;
  }
  throw new Error("Cannot seed a transient value");
}

export async function readSeedToken<T>(
  singletons: Scope,
  currentScope: Scope | null,
  token: string | symbol,
): Promise<{ value: T; source: SeedSource }> {
  if (currentScope?.has(token)) {
    return { value: (await currentScope.get(token)) as T, source: "scoped" };
  }
  if (singletons.has(token)) {
    return { value: (await singletons.get(token)) as T, source: "singleton" };
  }
  throw new Error(
    `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
  );
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test src/internal/seed-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/internal/seed-helpers.ts src/internal/seed-helpers.test.ts
git commit -m "feat: add seed helpers (writeSeed, readSeedToken)"
```

---

## Task 3: AlsSnabditel skeleton — standalone class with run + seed

**Files:**
- Modify: `src/als.ts` (full rewrite, no `extends Snabditel`)

- [ ] **Step 1: Verify existing als.test.ts still expects current behavior**

Run: `bun test src/als.test.ts`
Expected: existing tests run. Note any pre-existing failures so we know baseline before this task. Cycle detection test (line 75) currently fails / hangs — known; will pass by the end of this plan (Task 11).

- [ ] **Step 2: Rewrite `src/als.ts` skeleton**

Replace contents of `src/als.ts` with:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";
import { readSeedToken, writeSeed } from "./internal/seed-helpers";

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

  async resolve<T>(_token: Token<T>): Promise<T> {
    throw new Error("not implemented yet");
  }
}
```

- [ ] **Step 3: Run test to confirm structural rewrite compiles**

Run: `bun test src/als.test.ts 2>&1 | head -30`
Expected: existing tests fail because `resolve` throws "not implemented yet" — this is expected mid-rewrite. Compilation should succeed.

Run: `bun run typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit (work-in-progress checkpoint)**

```bash
git add src/als.ts
git commit -m "refactor(als): standalone AlsSnabditel skeleton with seed + run"
```

---

## Task 4: resolve string/symbol path with bubble

**Files:**
- Modify: `src/als.ts`

- [ ] **Step 1: Add a temporary failing test**

Append to `src/als.test.ts` (will be removed in Task 11 once full suite passes; keep until then):

```ts
test("resolve string token returns seeded singleton (skeleton wiring)", async () => {
  const s = new AlsSnabditel();
  s.seed("K", 42);
  expect(await s.resolve<number>("K")).toBe(42);
});

test("resolve symbol token returns seeded singleton", async () => {
  const s = new AlsSnabditel();
  const T = Symbol("t");
  s.seed(T, 5);
  expect(await s.resolve<number>(T)).toBe(5);
});

test("scoped seed shadows singleton seed within run", async () => {
  const s = new AlsSnabditel();
  s.seed("K", "global");
  await s.run(async () => {
    s.seed("K", "request", { injectionScope: "scoped" });
    expect(await s.resolve<string>("K")).toBe("request");
  });
  expect(await s.resolve<string>("K")).toBe("global");
});

test("unknown string token throws", async () => {
  const s = new AlsSnabditel();
  await expect(s.resolve("MISSING")).rejects.toThrow(/Unknown token/);
});
```

Run: `bun test src/als.test.ts -t "resolve string token returns seeded singleton"`
Expected: FAIL — `resolve` throws "not implemented yet".

- [ ] **Step 2: Implement string/symbol path with frame-bubble**

Update `src/als.ts`. Add the following private methods and rewrite `resolve` to handle string/symbol only for now:

```ts
import {
  effectiveScopedNoRunError,
  isWider,
  mismatchError,
  narrower,
  scopeOf,
} from "./internal/scope-helpers";
```

Add inside the class (above `resolve`):

```ts
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
```

Replace `resolve` body:

```ts
async resolve<T>(token: Token<T>): Promise<T> {
  if (typeof token === "string" || typeof token === "symbol") {
    const scope = this.scopeAls.getStore() ?? null;
    const result = await readSeedToken<T>(this.singletons, scope, token);
    this.bubble(result.source);
    return result.value;
  }
  throw new Error("not implemented yet");
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/als.test.ts -t "resolve string token returns seeded singleton"`
Run: `bun test src/als.test.ts -t "resolve symbol token returns seeded singleton"`
Run: `bun test src/als.test.ts -t "scoped seed shadows singleton seed within run"`
Run: `bun test src/als.test.ts -t "unknown string token throws"`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/als.ts src/als.test.ts
git commit -m "feat(als): resolve string/symbol path with scope-bubble"
```

---

## Task 5: builder happy path — singleton owner, no deps

**Files:**
- Modify: `src/als.ts`

- [ ] **Step 1: Add failing test**

Append to `src/als.test.ts`:

```ts
test("plain class resolves and caches as singleton (no deps)", async () => {
  class Foo {}
  const s = new AlsSnabditel();
  const a = await s.resolve(Foo);
  const b = await s.resolve(Foo);
  expect(a).toBeInstanceOf(Foo);
  expect(a).toBe(b);
});

test("SelfResolvable singleton: createInstance awaited and cached", async () => {
  let calls = 0;
  const r: SelfResolvable<{ n: number }> = {
    createInstance: async () => {
      calls++;
      return { n: 7 };
    },
  };
  const s = new AlsSnabditel();
  const a = await s.resolve(r);
  const b = await s.resolve(r);
  expect(a.n).toBe(7);
  expect(a).toBe(b);
  expect(calls).toBe(1);
});
```

Run: `bun test src/als.test.ts -t "plain class resolves and caches as singleton"`
Expected: FAIL — "not implemented yet".

- [ ] **Step 2: Implement builder for singleton-effective owner**

Add private methods in `src/als.ts`:

```ts
private async build<T>(token: Resolvable<T>): Promise<T> {
  if ("createInstance" in token) {
    return await token.createInstance();
  }
  return new (token as new () => T)();
}

private async builder<T>(token: Resolvable<T>): Promise<T> {
  const declared = scopeOf(token);
  const frame: Frame = {
    ownerToken: token,
    declared,
    minScope: "singleton",
    parent: this.frameAls.getStore() ?? null,
  };

  let resolveSettled!: (r: BuildResult<T>) => void;
  let rejectSettled!: (e: unknown) => void;
  const pending = new Promise<BuildResult<T>>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
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
```

Extend `resolve` to handle Resolvable cache + builder:

```ts
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

  // inFlight + waiter handled in Task 9; for now go straight to builder
  return this.builder(token);
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/als.test.ts -t "plain class resolves and caches as singleton"`
Run: `bun test src/als.test.ts -t "SelfResolvable singleton: createInstance awaited"`
Expected: PASS.

Run pre-existing tests not yet covered to monitor regressions:
Run: `bun test src/als.test.ts -t "singleton works as in base class"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/als.ts src/als.test.ts
git commit -m "feat(als): builder for singleton owners with no deps"
```

---

## Task 6: explicit scoped + transient owners

**Files:**
- Modify: `src/als.ts` (no code change — verify behavior already covered by builder + cache placement)
- Modify: `src/als.test.ts` (add tests)

- [ ] **Step 1: Add failing tests**

Append to `src/als.test.ts`:

```ts
test("explicit scoped: same instance within run, different across runs", async () => {
  const r: SelfResolvable<{ id: number }> = {
    createInstance: () => ({ id: Math.random() }),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const a = await s.run(async () => {
    const x = await s.resolve(r);
    const y = await s.resolve(r);
    expect(x).toBe(y);
    return x;
  });
  const b = await s.run(async () => s.resolve(r));
  expect(a).not.toBe(b);
});

test("explicit transient: new instance each resolve, no cache", async () => {
  const r: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new AlsSnabditel();
  const a = await s.resolve(r);
  const b = await s.resolve(r);
  expect(a).not.toBe(b);
});

test("explicit scoped resolved outside run throws", async () => {
  const r: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  await expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
});
```

Run: `bun test src/als.test.ts -t "explicit scoped: same instance"`
Expected: PASS already (`builder` + `placeIntoCache` cover this).

Run: `bun test src/als.test.ts -t "explicit transient: new instance"`
Expected: PASS already.

Run: `bun test src/als.test.ts -t "explicit scoped resolved outside run throws"`
Expected: PASS already (throws via `placeIntoCache`).

- [ ] **Step 2: If any of the above failed, fix in `src/als.ts` and re-run.** No code change expected; this task is a verification + lock-in.

- [ ] **Step 3: Commit**

```bash
git add src/als.test.ts
git commit -m "test(als): cover explicit scoped + transient owner behavior"
```

---

## Task 7: scope inheritance — unset owner inherits narrower dep

**Files:**
- Modify: `src/als.ts` (likely no code change — `bubble` + `effective ?? frame.minScope` already does this)
- Modify: `src/als.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/als.test.ts`:

```ts
test("unset owner depending on scoped dep becomes scoped", async () => {
  const A: SelfResolvable<{ tag: "A" }> = {
    createInstance: () => ({ tag: "A" }),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const B: SelfResolvable<{ a: { tag: "A" } }> = {
    // no injectionScope
    createInstance: async () => ({ a: await s.resolve(A) }),
  };

  const b1 = await s.run(async () => s.resolve(B));
  const b2 = await s.run(async () => s.resolve(B));
  expect(b1).not.toBe(b2);
  expect(b1.a).not.toBe(b2.a);
});

test("unset owner depending only on singleton stays singleton", async () => {
  class Logger {}
  const s = new AlsSnabditel();
  const Wrapper: SelfResolvable<{ l: Logger }> = {
    createInstance: async () => ({ l: await s.resolve(Logger) }),
  };

  const w1 = await s.resolve(Wrapper);
  const w2 = await s.resolve(Wrapper);
  expect(w1).toBe(w2);
});

test("unset owner depending on transient dep becomes transient", async () => {
  const T: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new AlsSnabditel();
  const Owner: SelfResolvable<{ t: object }> = {
    createInstance: async () => ({ t: await s.resolve(T) }),
  };

  const o1 = await s.resolve(Owner);
  const o2 = await s.resolve(Owner);
  expect(o1).not.toBe(o2);
});

test("mixed deps {singleton, scoped} on unset owner -> scoped", async () => {
  class Singleton {}
  const Scoped: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const Owner: SelfResolvable<{ sg: Singleton; sc: object }> = {
    createInstance: async () => ({
      sg: await s.resolve(Singleton),
      sc: await s.resolve(Scoped),
    }),
  };

  const o1 = await s.run(async () => s.resolve(Owner));
  const o2 = await s.run(async () => s.resolve(Owner));
  expect(o1).not.toBe(o2);
});

test("mixed deps {singleton, scoped, transient} on unset owner -> transient", async () => {
  class Singleton {}
  const Scoped: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const Transient: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new AlsSnabditel();
  const Owner: SelfResolvable<{ sg: Singleton; sc: object; tr: object }> = {
    createInstance: async () => ({
      sg: await s.resolve(Singleton),
      sc: await s.resolve(Scoped),
      tr: await s.resolve(Transient),
    }),
  };

  const [o1, o2] = await s.run(async () => [
    await s.resolve(Owner),
    await s.resolve(Owner),
  ]);
  expect(o1).not.toBe(o2);
});

test("string seed dep scope inferred from cache location: scoped seed -> owner scoped", async () => {
  const s = new AlsSnabditel();
  s.seed("CFG", { v: 1 });
  const Owner: SelfResolvable<{ cfg: { v: number } }> = {
    createInstance: async () => ({ cfg: await s.resolve<{ v: number }>("CFG") }),
  };

  await s.run(async () => {
    s.seed("CFG", { v: 2 }, { injectionScope: "scoped" });
    const o1 = await s.resolve(Owner);
    expect(o1.cfg.v).toBe(2);
  });
  await s.run(async () => {
    s.seed("CFG", { v: 3 }, { injectionScope: "scoped" });
    const o2 = await s.resolve(Owner);
    expect(o2.cfg.v).toBe(3);
  });
});
```

Run: `bun test src/als.test.ts -t "unset owner depending on scoped dep becomes scoped"`
Expected: PASS — bubble + effective inheritance already covers this.

If any failure, debug and fix in `src/als.ts`. Likely fix area: `bubble` or `placeIntoCache` ordering.

Run all the tests added in this task:
Run: `bun test src/als.test.ts -t "unset owner"`
Run: `bun test src/als.test.ts -t "mixed deps"`
Run: `bun test src/als.test.ts -t "string seed dep scope inferred"`
Expected: all PASS.

- [ ] **Step 2: Commit**

```bash
git add src/als.test.ts
git commit -m "test(als): scope inheritance via narrowest dep"
```

---

## Task 8: validation — declared wider than dep throws

**Files:**
- Modify: `src/als.ts` (no code change expected — `bubble` early-throw + post-build check already cover this)
- Modify: `src/als.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/als.test.ts`:

```ts
test("explicit singleton + scoped dep throws clear error", async () => {
  const A: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  class B {
    static readonly injectionScope = "singleton" as const;
    static async createInstance() {
      await s.resolve(A);
      return new B();
    }
  }

  await expect(s.run(async () => s.resolve(B))).rejects.toThrow(
    /Cannot resolve B as singleton: depends on a scoped service/,
  );
});

test("explicit singleton + transient dep throws", async () => {
  const A: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new AlsSnabditel();
  class B {
    static readonly injectionScope = "singleton" as const;
    static async createInstance() {
      await s.resolve(A);
      return new B();
    }
  }

  await expect(s.resolve(B)).rejects.toThrow(
    /Cannot resolve B as singleton: depends on a transient service/,
  );
});

test("explicit scoped + transient dep throws", async () => {
  const A: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "transient",
  };
  const s = new AlsSnabditel();
  class B {
    static readonly injectionScope = "scoped" as const;
    static async createInstance() {
      await s.resolve(A);
      return new B();
    }
  }

  await expect(s.run(async () => s.resolve(B))).rejects.toThrow(
    /Cannot resolve B as scoped: depends on a transient service/,
  );
});

test("explicit transient + scoped dep ok", async () => {
  const A: SelfResolvable<{ tag: "A" }> = {
    createInstance: () => ({ tag: "A" }),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const B: SelfResolvable<{ a: { tag: "A" } }> = {
    createInstance: async () => ({ a: await s.resolve(A) }),
    injectionScope: "transient",
  };

  await s.run(async () => {
    const b1 = await s.resolve(B);
    const b2 = await s.resolve(B);
    expect(b1).not.toBe(b2);          // transient: fresh each time
    expect(b1.a).toBe(b2.a);          // shared scoped A within run
  });
});

test("explicit scoped + singleton dep ok", async () => {
  class A {}
  const s = new AlsSnabditel();
  const B: SelfResolvable<{ a: A }> = {
    createInstance: async () => ({ a: await s.resolve(A) }),
    injectionScope: "scoped",
  };

  await s.run(async () => {
    const b = await s.resolve(B);
    expect(b.a).toBeInstanceOf(A);
  });
});

test("validation error aborts createInstance early (side effects after first violating resolve do not run)", async () => {
  const A: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  let sideEffect = 0;
  class B {
    static readonly injectionScope = "singleton" as const;
    static async createInstance() {
      await s.resolve(A);
      sideEffect++;          // must NOT run — bubble should throw before reaching here
      return new B();
    }
  }

  await expect(s.run(async () => s.resolve(B))).rejects.toThrow(/singleton/);
  expect(sideEffect).toBe(0);
});
```

Run: `bun test src/als.test.ts -t "explicit singleton + scoped dep"`
Expected: PASS — `bubble` throws via `mismatchError` once dep's scope reported.

Run: `bun test src/als.test.ts -t "validation error aborts createInstance early"`
Expected: PASS — early throw inside `bubble` aborts before `sideEffect++`.

If failures, debug `bubble` / `mismatchError` formatting.

Run all task-8 tests:
Run: `bun test src/als.test.ts -t "explicit"`
Expected: all PASS.

- [ ] **Step 2: Commit**

```bash
git add src/als.test.ts
git commit -m "test(als): validation throws when declared wider than dep"
```

---

## Task 9: in-flight lock + waiter dispatch

**Files:**
- Modify: `src/als.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/als.test.ts`:

```ts
test("concurrent same-run resolves of unset-scope token: single build (lock)", async () => {
  let calls = 0;
  const Slow: SelfResolvable<{ id: number }> = {
    createInstance: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { id: calls };
    },
  };
  const s = new AlsSnabditel();
  const [a, b, c] = await Promise.all([
    s.resolve(Slow),
    s.resolve(Slow),
    s.resolve(Slow),
  ]);
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(calls).toBe(1);
});

test("concurrent cross-run resolves: unset -> singleton -> single build", async () => {
  let calls = 0;
  const Slow: SelfResolvable<{ id: number }> = {
    createInstance: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { id: calls };
    },
  };
  const s = new AlsSnabditel();
  const [a, b] = await Promise.all([
    s.run(async () => s.resolve(Slow)),
    s.run(async () => s.resolve(Slow)),
  ]);
  expect(a).toBe(b);
  expect(calls).toBe(1);
});

test("concurrent cross-run resolves: unset -> scoped -> each run rebuilds with own value", async () => {
  let calls = 0;
  const A: SelfResolvable<{ tag: "A"; n: number }> = {
    createInstance: () => ({ tag: "A", n: ++calls }),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const Owner: SelfResolvable<{ a: { tag: "A"; n: number } }> = {
    createInstance: async () => ({ a: await s.resolve(A) }),
  };

  const [o1, o2] = await Promise.all([
    s.run(async () => s.resolve(Owner)),
    s.run(async () => s.resolve(Owner)),
  ]);
  expect(o1).not.toBe(o2);
  expect(o1.a).not.toBe(o2.a);
});

test("builder rejects: all waiters get same rejection, no cache", async () => {
  let calls = 0;
  const Bad: SelfResolvable<{ ok: boolean }> = {
    createInstance: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("boom");
    },
  };
  const s = new AlsSnabditel();
  const results = await Promise.allSettled([
    s.resolve(Bad),
    s.resolve(Bad),
    s.resolve(Bad),
  ]);
  for (const r of results) {
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect((r.reason as Error).message).toBe("boom");
    }
  }
  expect(calls).toBe(1);
});

test("effective-scoped token resolved outside run throws clear error", async () => {
  const A: SelfResolvable<object> = {
    createInstance: () => ({}),
    injectionScope: "scoped",
  };
  const s = new AlsSnabditel();
  const Owner: SelfResolvable<{ a: object }> = {
    createInstance: async () => ({ a: await s.resolve(A) }),
  };

  await expect(s.resolve(Owner)).rejects.toThrow(
    /effective scope is 'scoped'.*no run\(\) scope is active/,
  );
});
```

Run: `bun test src/als.test.ts -t "concurrent same-run resolves of unset-scope token"`
Expected: FAIL — `calls` is 3 (no waiter dispatch yet — each builder runs).

- [ ] **Step 2: Implement waiter dispatch**

Update `resolve` in `src/als.ts` to consult `inFlight` before falling through to builder, and add `waiter` method:

```ts
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
```

- [ ] **Step 3: Run tests**

Run: `bun test src/als.test.ts -t "concurrent same-run"`
Run: `bun test src/als.test.ts -t "concurrent cross-run"`
Run: `bun test src/als.test.ts -t "builder rejects: all waiters"`
Run: `bun test src/als.test.ts -t "effective-scoped token resolved outside run"`
Expected: all PASS.

Run pre-existing tests:
Run: `bun test src/als.test.ts -t "concurrent runs resolving same singleton"`
Run: `bun test src/als.test.ts -t "concurrent resolve of same scoped within one run"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/als.ts src/als.test.ts
git commit -m "feat(als): single-flight inFlight lock + waiter dispatch"
```

---

## Task 10: cycle detection via frame parent chain

**Files:**
- Modify: `src/als.ts`

- [ ] **Step 1: Confirm existing cycle test fails**

Run: `bun test src/als.test.ts -t "cycle still detected within single resolve chain"`
Expected: FAIL or hang — without cycle detection, `resolve(a)` → builder for `a` → calls `resolve(b)` → builder for `b` → calls `resolve(a)` → finds `a` in `inFlight` → becomes waiter → awaits `a`'s pending which is awaiting `b`'s pending which is awaiting waiter → deadlock.

(If the test hangs rather than fails, kill it after a few seconds. Move on.)

- [ ] **Step 2: Add cycle check to builder before installing inFlight**

Modify `builder` in `src/als.ts`. Before constructing the pending promise, walk the frame parent chain:

```ts
private async builder<T>(token: Resolvable<T>): Promise<T> {
  const parent = this.frameAls.getStore() ?? null;

  // Cycle detection: walk parent chain looking for the same owner token.
  for (let f: Frame | null = parent; f !== null; f = f.parent) {
    if (f.ownerToken === token) {
      throw new Error("Cycle detected during resolution");
    }
  }

  const declared = scopeOf(token);
  const frame: Frame = {
    ownerToken: token,
    declared,
    minScope: "singleton",
    parent,
  };
  // ... rest unchanged
```

- [ ] **Step 3: Run cycle test**

Run: `bun test src/als.test.ts -t "cycle still detected within single resolve chain"`
Expected: PASS — `Cycle detected during resolution`.

- [ ] **Step 4: Run full als suite to confirm no regressions**

Run: `bun test src/als.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/als.ts
git commit -m "feat(als): cycle detection via frame parent chain"
```

---

## Task 11: full sweep — Snabditel suite still passes, typecheck, build

**Files:** none modified; verification only.

- [ ] **Step 1: Run base Snabditel tests**

Run: `bun test src/snabditel.test.ts`
Expected: all PASS (base unchanged).

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: all PASS across `als.test.ts`, `snabditel.test.ts`, `internal/*.test.ts`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: success, dist files written.

- [ ] **Step 5: If any step fails, fix root cause** in the relevant file from prior tasks (do NOT add new behavior here). Re-run from Step 1.

- [ ] **Step 6: Commit (no-op if nothing to add)**

If any incidental fixes were made (e.g. type tweaks), commit them:

```bash
git add -A
git commit -m "chore: typecheck + build pass after AlsSnabditel rewrite"
```

If nothing changed, skip the commit.

---

## Task 12: README update — document new behavior

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find scope section and add inheritance subsection**

Read `README.md`, locate the `## Scopes` section. Add a new subsection right after the existing scopes table:

```markdown
### Scope inheritance and validation (`AlsSnabditel`)

In `AlsSnabditel`, a token's effective scope is the narrowest scope of its dependencies when `injectionScope` is omitted, and an explicit `injectionScope` that is wider than its narrowest dependency throws at resolve time.

Lifetime ordering, narrowest to widest: `transient` → `scoped` → `singleton`.

```ts
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class RequestId { static readonly injectionScope = "scoped" as const; }

class UserService {
  // No injectionScope. Effective scope = scoped (inherited from RequestId).
  static async createInstance() {
    const id = await di.resolve(RequestId);
    return new UserService(id);
  }
  constructor(private id: RequestId) {}
}

class BadCache {
  static readonly injectionScope = "singleton" as const;
  static async createInstance() {
    await di.resolve(RequestId);          // throws: declared singleton, dep is scoped
    return new BadCache();
  }
}
```

Inference and validation are first-resolve operations. Once a token is cached, subsequent resolves do not re-evaluate. Base `Snabditel` does not implement inheritance or validation; declared `injectionScope` is taken as-is.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document AlsSnabditel scope inheritance and validation"
```

---

## Self-review

**Spec coverage:**
- Goals 1-2 (inherit narrowest, throw on wider declared): Tasks 7, 8.
- Goal 3 (single-flight dedupe preserved): Task 9.
- Goal 4 (no API breakage): Task 11 verifies Snabditel suite.
- Scope rules table: Task 1 helpers + Tasks 7-8 tests.
- Dep scope sources (string/symbol via cache location): Task 2 + Task 7's "string seed dep scope inferred" test.
- AlsSnabditel internals (frameAls, scopeAls, inFlight): Tasks 3-9.
- Builder + Waiter pseudocode: Tasks 5, 9.
- Errors (mismatch + effective-scoped-no-run): Task 1 builders + Tasks 8, 9 tests.
- Edge cases: covered by Task 7 (mixed deps), Task 9 (concurrent cross-run, builder rejects), Task 10 (cycle).
- Test plan items 1-17: mapped across Tasks 4-11. Item 17 (Snabditel tests unchanged) = Task 11.
- Cycle detection (extension beyond spec, required by existing als.test.ts): Task 10.

**Placeholder scan:** none — all steps contain runnable commands and complete code blocks.

**Type / signature consistency:** `Frame`, `BuildResult`, `Scope`, `Key`, `narrower`, `isWider`, `scopeOf`, `ownerName`, `mismatchError`, `effectiveScopedNoRunError`, `writeSeed`, `readSeedToken`, `placeIntoCache`, `bubble`, `builder`, `waiter`, `build` — all defined exactly once and referenced consistently in later tasks.

---

## Notes for the implementer

- All new modules go under `src/internal/`. They are not part of the published API.
- `AsyncLocalStorage` import lives only in `src/als.ts`. Do not import from `node:async_hooks` in `src/snabditel.ts` or any helper used by it.
- `bubble` throws synchronously inside the `frameAls.run` callback during `createInstance` — that propagates as a rejected promise from the `await` site. The test `"validation error aborts createInstance early"` covers this contract.
- The waiter restart path uses a tail call `return this.resolve(token)`. JavaScript does not have proper TCO but this is bounded: once the original builder cleared `inFlight`, the restart path either becomes a builder or finds a fresh in-flight that converges.
- Do not delete the temporary tests added in Task 4. They become permanent regression tests.
