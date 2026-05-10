# Inline `internal/` helpers and clean up post-inheritance Snabditel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `src/internal/` by absorbing every helper into the class that uses it as a `private` method, and tighten `Snabditel` after the subclass relationship was removed — without changing public API, error messages, or runtime behavior.

**Architecture:** `AlsSnabditel` absorbs all six scope-math helpers (`narrower`, `isWider`, `scopeOf`, `ownerName`, `mismatchError`, `effectiveScopedNoRunError`) and both seed helpers (`writeSeed`, `readSeedToken`) as private instance methods that read `this.singletons` and `this.scopeAls` directly. `Snabditel` switches `protected → private` on members that were exposed only for the now-removed subclass, removes `getScope()`, splits `resolve()` into `resolveSeeded` / `resolveBinding`, inlines the trivial `scopeOf` and `seed()` body. Spec: `docs/superpowers/specs/2026-05-09-internal-helpers-inlining-design.md`.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run build`), Node `AsyncLocalStorage`.

**Test discipline:** This is a pure refactor — behavior preserved. The existing `snabditel.test.ts` and `als.test.ts` are the safety net. The plan ports the deleted helper unit tests to `als.test.ts` as black-box assertions BEFORE removing the helpers, so coverage is preserved at every commit.

---

## File map

```
src/
  als.ts                  # Task 2 + Task 3: absorbs scope-helpers + seed-helpers as private methods
  als.test.ts             # Task 1: ports deleted helper-test cases as black-box tests
  als-index.ts            # unchanged
  snabditel.ts            # Task 5: protected→private, split resolve(), inline scopeOf + seed body
  snabditel.test.ts       # unchanged
  snabditel.types.ts      # unchanged
  index.ts                # unchanged
  types.test-d.ts         # unchanged
  internal/               # deleted in Tasks 2/3/4
    scope-helpers.ts      # deleted in Task 2
    scope-helpers.test.ts # deleted in Task 2
    seed-helpers.ts       # deleted in Task 3
    seed-helpers.test.ts  # deleted in Task 3
```

No public API change. `index.ts` and `als-index.ts` re-exports unchanged. No new public types.

---

## Task 1: Port helper-unit-test cases to `als.test.ts` as black-box tests

**Why first:** Helper unit tests (`scope-helpers.test.ts`, `seed-helpers.test.ts`) get deleted in Tasks 2 and 3. Before that happens we add black-box equivalents on `AlsSnabditel` so coverage doesn't regress at any commit. These new tests pass against the current implementation that still imports from `src/internal/` — they are purely additive.

**Files:**
- Modify: `src/als.test.ts` (append new `describe` block at end of `describe("AlsSnabditel", ...)`)

**Coverage gap analysis** (cases asserted only by deleted helper tests today):

| Helper-test case | Black-box equivalent on `AlsSnabditel` |
|---|---|
| `mismatchError` full message wording — `inherit '<min>'`, `'<min>' or 'transient'` | Trigger via `singleton + scoped dep` and assert message contains the phrases |
| `mismatchError` with anonymous SelfResolvable owner | Owner = `{ createInstance, injectionScope: "singleton" }` literal depending on a scoped dep — message contains `anonymous SelfResolvable` |
| `ownerName` — anonymous class (empty `name`) | Owner = anon class with `Object.defineProperty(C, "name", { value: "" })`, declared singleton, scoped dep — message contains `anonymous class` |
| `ownerName` — SelfResolvable instance with named constructor | Resolve `new MyFactory()` (instance is a SelfResolvable) declared singleton, scoped dep — message contains `MyFactory` |
| `effectiveScopedNoRunError` shape | Owner with no declared scope depending on scoped dep, resolve outside `run()` — assert message contains `inherited from a scoped dependency` |
| `readSeedToken` — cached promise values awaited | `s.seed("K", Promise.resolve(42)); expect(await s.resolve("K")).toBe(42)` |

Cases already covered (verify, do not duplicate):
- `narrower` / `isWider` — covered by scope-inheritance tests at lines 239–326 and validation-error tests at 347–402.
- `writeSeed` happy paths + scoped-without-run + transient — covered by the `seed` tests in `als.test.ts` lines 163–171 and analogous patterns. (Confirm during step 1; if a `transient`-throws test on `s.seed` is missing for AlsSnabditel, add it.)
- `readSeedToken` scope-shadows-singleton — covered at line 163.

---

- [ ] **Step 1: Verify baseline is green**

Run: `bun test`
Expected: All tests pass.

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 2: Append new test block to `src/als.test.ts`**

Add the following block immediately before the closing `});` of `describe("AlsSnabditel", ...)`:

```ts
  // ----- ported from deleted internal/ helper unit tests (black-box) -----

  test("mismatchError message: full wording for named class owner", async () => {
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
      /Cannot resolve B as singleton: depends on a scoped service\. Either remove `injectionScope` to inherit 'scoped', or set it to 'scoped' or 'transient'\./,
    );
  });

  test("mismatchError uses 'anonymous SelfResolvable' for object-literal owner", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ a: object }> = {
      createInstance: async () => ({ a: await s.resolve(A) }),
      injectionScope: "singleton",
    };
    await expect(s.run(async () => s.resolve(Owner))).rejects.toThrow(
      /Cannot resolve anonymous SelfResolvable as singleton: depends on a scoped service/,
    );
  });

  test("mismatchError uses 'anonymous class' for class with empty name", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Anon = class {
      static readonly injectionScope = "singleton" as const;
      static async createInstance() {
        await s.resolve(A);
        return new Anon();
      }
    };
    Object.defineProperty(Anon, "name", { value: "" });
    await expect(s.run(async () => s.resolve(Anon))).rejects.toThrow(
      /Cannot resolve anonymous class as singleton/,
    );
  });

  test("mismatchError uses constructor name for SelfResolvable instance owner", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    class MyFactory {
      readonly injectionScope = "singleton" as const;
      async createInstance() {
        await s.resolve(A);
        return {};
      }
    }
    const owner = new MyFactory() as SelfResolvable<object>;
    await expect(s.run(async () => s.resolve(owner))).rejects.toThrow(
      /Cannot resolve MyFactory as singleton/,
    );
  });

  test("effectiveScopedNoRunError message wording when inherited scoped resolved outside run", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ a: object }> = {
      // no declared injectionScope — effective inherits 'scoped'
      createInstance: async () => ({ a: await s.resolve(A) }),
    };
    await expect(s.resolve(Owner)).rejects.toThrow(
      /effective scope is 'scoped' \(inherited from a scoped dependency\) but no run\(\) scope is active/,
    );
  });

  test("seed under string token with Promise value: resolve awaits it", async () => {
    const s = new AlsSnabditel();
    s.seed<number>("K", Promise.resolve(42) as unknown as number);
    expect(await s.resolve<number>("K")).toBe(42);
  });

  test("seed transient on AlsSnabditel throws", () => {
    const s = new AlsSnabditel();
    expect(() => s.seed("X", {}, { injectionScope: "transient" })).toThrow(
      /transient/,
    );
  });
```

- [ ] **Step 3: Run new tests against current implementation**

Run: `bun test src/als.test.ts`
Expected: All tests pass — including the seven new ones. (They exercise behavior produced by the still-imported helpers in `src/internal/`.)

- [ ] **Step 4: Commit**

```bash
git add src/als.test.ts
git commit -m "test(als): port helper-unit cases to als.test.ts as black-box"
```

---

## Task 2: Inline `scope-helpers` as private methods on `AlsSnabditel`

**Why:** Six free functions in `src/internal/scope-helpers.ts` are imported only by `als.ts`. Make them private methods on `AlsSnabditel`. Stateless but uniform with the stateful methods on the same class. After this task `src/internal/scope-helpers.ts` and its `.test.ts` are deleted; the directory still has the seed pair until Task 3.

**Files:**
- Modify: `src/als.ts` (replace import block; add six private methods)
- Delete: `src/internal/scope-helpers.ts`
- Delete: `src/internal/scope-helpers.test.ts`

- [ ] **Step 1: Edit `src/als.ts` — drop scope-helpers import**

Replace the top import block (lines 1–16) with:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  SelfResolvable,
  Token,
} from "./snabditel.types";
import { readSeedToken, writeSeed } from "./internal/seed-helpers";
```

Note: `SelfResolvable` is added to the type import list — `ownerName` (now a method) needs it.

- [ ] **Step 2: Add `RANK` table at module level**

Immediately above `export class AlsSnabditel ...`, add:

```ts
const RANK: Record<InjectionScope, number> = {
  transient: 0,
  scoped: 1,
  singleton: 2,
};
```

- [ ] **Step 3: Add six private scope-math methods on `AlsSnabditel`**

Inside the class, after `private inFlight = new Map<...>();` and before `async run<T>(...)`, insert:

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
    if (ctor && ctor.name && ctor.name !== "Object") {
      return ctor.name;
    }
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

- [ ] **Step 4: Replace call sites in `als.ts`**

Search the file for `narrower(`, `isWider(`, `scopeOf(`, `mismatchError(`, `effectiveScopedNoRunError(` (free-function calls) and prefix each with `this.`. There are five call sites in the current code:

- `bubble`: `narrower(frame.minScope, scope)` → `this.narrower(...)`
- `bubble`: `isWider(frame.declared, frame.minScope)` → `this.isWider(...)`
- `bubble`: `mismatchError(frame.ownerToken, frame.declared, frame.minScope)` → `this.mismatchError(...)`
- `builder`: `scopeOf(token)` → `this.scopeOf(token)`
- `builder`: `isWider(declared, frame.minScope)` → `this.isWider(...)`
- `builder`: `mismatchError(token, declared, frame.minScope)` → `this.mismatchError(...)`
- `placeIntoCache`: `effectiveScopedNoRunError(token)` → `this.effectiveScopedNoRunError(token)`

(`ownerName` has no direct call site in `als.ts` today; it is only called inside `mismatchError` / `effectiveScopedNoRunError`. After this task its only callers are the two error methods on the same class — `this.ownerName(...)`.)

- [ ] **Step 5: Remove the `scope-helpers` import line**

Delete:

```ts
import {
  effectiveScopedNoRunError,
  isWider,
  mismatchError,
  narrower,
  scopeOf,
} from "./internal/scope-helpers";
```

(Should already be gone after Step 1 if the import block was replaced verbatim. Verify.)

- [ ] **Step 6: Delete the helper files**

```bash
rm src/internal/scope-helpers.ts src/internal/scope-helpers.test.ts
```

- [ ] **Step 7: Verify**

Run: `bun run typecheck`
Expected: No errors.

Run: `bun test`
Expected: All tests pass — including the seven black-box tests added in Task 1, which now exercise the private-method versions.

Run: `grep -rn "scope-helpers" src`
Expected: zero matches.

- [ ] **Step 8: Commit**

```bash
git add -A src/als.ts src/internal/
git commit -m "refactor(als): inline scope-helpers as private methods, delete src/internal/scope-helpers"
```

---

## Task 3: Inline `seed-helpers` as private methods on `AlsSnabditel`

**Why:** `writeSeed` and `readSeedToken` take `singletons` and a `getScope` callback only because they live outside the class. Move them in, drop the parameters, read `this.singletons` and `this.scopeAls` directly. Also introduce a small `currentScope()` private getter to centralise the `this.scopeAls.getStore() ?? null` access pattern.

**Files:**
- Modify: `src/als.ts` (drop seed-helpers import; add three private methods; rewrite `seed()` body and the string/symbol branch of `resolve()`)
- Delete: `src/internal/seed-helpers.ts`
- Delete: `src/internal/seed-helpers.test.ts`

- [ ] **Step 1: Edit `src/als.ts` — drop seed-helpers import**

Remove this line:

```ts
import { readSeedToken, writeSeed } from "./internal/seed-helpers";
```

- [ ] **Step 2: Add module-level `SeedSource` type**

Below the `BuildResult<T>` type, add:

```ts
type SeedSource = "singleton" | "scoped";
```

- [ ] **Step 3: Add `currentScope`, `writeSeed`, `readSeedToken` as private methods**

Inside the class, alongside the other private helpers (e.g. immediately after `bubble`), insert:

```ts
  private currentScope(): Scope | null {
    return this.scopeAls.getStore() ?? null;
  }

  private writeSeed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    const injectionScope = options.injectionScope ?? "singleton";
    if (injectionScope === "singleton") {
      this.singletons.set(token, value);
      return;
    }
    if (injectionScope === "scoped") {
      const scope = this.currentScope();
      if (!scope) {
        throw new Error("Scoped seed requires an active run() scope");
      }
      scope.set(token, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  private async readSeedToken<T>(
    token: string | symbol,
  ): Promise<{ value: T; source: SeedSource }> {
    const scope = this.currentScope();
    if (scope?.has(token)) {
      return { value: (await scope.get(token)) as T, source: "scoped" };
    }
    if (this.singletons.has(token)) {
      return { value: (await this.singletons.get(token)) as T, source: "singleton" };
    }
    throw new Error(
      `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
    );
  }
```

- [ ] **Step 4: Rewrite `seed()` to call the private method**

Current body:

```ts
  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    writeSeed(this.singletons, () => this.scopeAls.getStore() ?? null, token, value, options);
  }
```

Becomes:

```ts
  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    this.writeSeed(token, value, options);
  }
```

- [ ] **Step 5: Rewrite the string/symbol branch of `resolve()`**

Current:

```ts
    if (typeof token === "string" || typeof token === "symbol") {
      const scope = this.scopeAls.getStore() ?? null;
      const result = await readSeedToken<T>(this.singletons, scope, token);
      this.bubble(result.source);
      return result.value;
    }
```

Becomes:

```ts
    if (typeof token === "string" || typeof token === "symbol") {
      const result = await this.readSeedToken<T>(token);
      this.bubble(result.source);
      return result.value;
    }
```

- [ ] **Step 6: Replace remaining `this.scopeAls.getStore() ?? null` reads with `this.currentScope()`**

In `resolve()` and `waiter()`, replace inline `this.scopeAls.getStore() ?? null` with `this.currentScope()`. Specifically:

- `resolve()` `const currentScope = this.scopeAls.getStore() ?? null;` → `const currentScope = this.currentScope();`
- `builder()` `const builtInScope = this.scopeAls.getStore() ?? null;` → `const builtInScope = this.currentScope();`
- `resolve()` cycle-check guard: `this.assertNoCycle(token, this.frameAls.getStore() ?? null);` — leave as-is (frame chain, not scope chain).
- `waiter()` `(this.scopeAls.getStore() ?? null) === result.builtInScope` → `this.currentScope() === result.builtInScope`

(`run()` body still creates the new scope via `this.scopeAls.run(new Map(), callback)` — no change.)

- [ ] **Step 7: Delete the helper files**

```bash
rm src/internal/seed-helpers.ts src/internal/seed-helpers.test.ts
```

- [ ] **Step 8: Verify**

Run: `bun run typecheck`
Expected: No errors.

Run: `bun test`
Expected: All tests pass.

Run: `grep -rn "seed-helpers" src`
Expected: zero matches.

- [ ] **Step 9: Commit**

```bash
git add -A src/als.ts src/internal/
git commit -m "refactor(als): inline seed-helpers as private methods, delete src/internal/seed-helpers"
```

---

## Task 4: Remove the now-empty `src/internal/` directory

**Why:** Tasks 2 and 3 deleted all four files in `src/internal/`. The directory should be empty; remove it so no future code drifts back into it.

**Files:**
- Delete: `src/internal/` (directory)

- [ ] **Step 1: Confirm directory is empty**

Run: `ls src/internal`
Expected: empty output (or `ls: cannot access ...: No such file or directory` if Bun/git already collapsed it; either is fine — proceed to Step 2).

- [ ] **Step 2: Remove the directory**

```bash
rmdir src/internal 2>/dev/null || true
```

(`rmdir` fails harmlessly if the directory is already gone. Do not use `rm -rf` — empty dir only.)

- [ ] **Step 3: Verify no `internal/` references remain anywhere in the source tree**

Run: `grep -rn "internal/" src`
Expected: zero matches.

Run: `grep -rn "from \"\\./internal" src`
Expected: zero matches.

- [ ] **Step 4: Verify build still works**

Run: `bun run typecheck`
Expected: No errors.

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 5: Commit (skip if directory removal already absorbed by Tasks 2/3 commits)**

If `git status` shows the deleted directory or any remaining changes:

```bash
git add -A
git commit -m "chore: remove empty src/internal directory"
```

If `git status` is clean, this task produced no commit — that is fine; deletions in Tasks 2 and 3 were sufficient.

---

## Task 5: Restructure `Snabditel` post-inheritance

**Why:** `Snabditel` carries `protected` modifiers and a `getScope()` accessor that existed only to support the now-removed `AlsSnabditel extends Snabditel` relationship. With no subclass, all members tighten to `private`, the accessor disappears, and `resolve()` gets split into `resolveSeeded` / `resolveBinding` for readability. The trivial `scopeOf` (three lines, single call site) inlines into `resolveBinding`. The `seed()` body inlines too — single call site, simple branching, no helper needed.

Behavior is unchanged. Every existing throw site keeps the same condition and message.

**Files:**
- Modify: `src/snabditel.ts` (full rewrite of class body — no public-API change)
- Test: `src/snabditel.test.ts` (unchanged — must stay green)

- [ ] **Step 1: Verify baseline**

Run: `bun test src/snabditel.test.ts`
Expected: All tests pass.

- [ ] **Step 2: Replace class body in `src/snabditel.ts`**

Replace the full contents of `src/snabditel.ts` with:

```ts
import type {
  ASnabditel,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";

type Key = unknown;
type Scope = Map<Key, unknown>;

export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private localScope: Scope | null = null;

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    const injectionScope = options.injectionScope ?? "singleton";
    if (injectionScope === "singleton") {
      this.singletons.set(token as Key, value);
      return;
    }
    if (injectionScope === "scoped") {
      if (!this.localScope) {
        throw new Error("Scoped seed requires an active run() scope");
      }
      this.localScope.set(token as Key, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.localScope) {
      throw new Error(
        "run() already active — concurrent scopes require AlsSnabditel",
      );
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
    if (this.localScope?.has(token)) {
      return (await this.localScope.get(token)) as T;
    }
    if (this.singletons.has(token)) {
      return (await this.singletons.get(token)) as T;
    }
    throw new Error(
      `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
    );
  }

  private async resolveBinding<T>(token: Resolvable<T>): Promise<T> {
    const injectionScope =
      ("injectionScope" in token ? token.injectionScope : undefined) ?? "singleton";

    if (injectionScope === "singleton") {
      return this.cacheBuild(this.singletons, token);
    }
    if (injectionScope === "scoped") {
      if (!this.localScope) {
        throw new Error("Scoped resolution requires an active run() scope");
      }
      return this.cacheBuild(this.localScope, token);
    }
    return this.build(token);
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
    if ("createInstance" in binding) {
      return await binding.createInstance();
    }
    return new binding();
  }
}
```

Diff vs current code:

- `protected` → `private` on `singletons`, `localScope`, `build`.
- `getScope()` method removed; callers (`seed`, `resolveBinding`) read `this.localScope` directly.
- `scopeOf<T>()` private method removed; the three-line ternary is inlined at the single call site in `resolveBinding`.
- `resolve()` splits into a three-line dispatch + two branch methods (`resolveSeeded`, `resolveBinding`).
- `seed()` body keeps its branching inline — no extracted helper.

All error messages, throw conditions, and runtime semantics are byte-identical to the prior implementation.

- [ ] **Step 3: Run snabditel tests**

Run: `bun test src/snabditel.test.ts`
Expected: All tests pass — every existing test in `snabditel.test.ts` covers a behavior preserved by this refactor.

- [ ] **Step 4: Run full test suite + typecheck**

Run: `bun run typecheck`
Expected: No errors.

Run: `bun test`
Expected: All tests pass (`snabditel.test.ts` + `als.test.ts` + `types.test-d.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/snabditel.ts
git commit -m "refactor(snabditel): private members, split resolve, inline scopeOf and seed body"
```

---

## Task 6: Final verification

**Why:** Spec requires zero `internal/` references, clean typecheck, green tests, and a build whose `dist/` diff is limited to expected file removals plus the restructured `als.js` / `snabditel.js`. This task does no code changes — just runs the verification gates and produces a commit-free pass/fail signal.

**Files:** none modified.

- [ ] **Step 1: Source-tree cleanliness checks**

Run: `grep -rn "internal/" src`
Expected: zero matches.

Run: `grep -rn "internal" src --include="*.ts" | grep -v "// " | grep -v "internal use"`
Expected: zero matches related to import paths. (Comment matches with the word "internal" used in prose are acceptable.)

Run: `ls src/internal 2>&1 | head -1`
Expected: `ls: src/internal: No such file or directory` (or equivalent).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: No errors. Exit code 0.

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: All tests pass. Output reports zero failures, zero skipped (unless skips already existed pre-refactor — confirm against baseline).

Note specifically that all seven tests added in Task 1 still pass — they are the coverage replacement for the deleted helper-unit tests.

- [ ] **Step 4: Production build**

Run: `bun run build`
Expected: Exit code 0. `dist/` regenerates with `esm/`, `cjs/`, `types/` subtrees.

- [ ] **Step 5: Inspect `dist/` for surface drift**

Run: `ls dist/types`
Expected: Only top-level type files (`index.d.ts`, `als-index.d.ts`, `snabditel.d.ts`, `als.d.ts`, `snabditel.types.d.ts`). No `internal/` subdirectory.

Run: `ls dist/esm` and `ls dist/cjs`
Expected: Only top-level `.js` files for the entry points (`index.js`, `als-index.js`). No `internal/` directory in either.

Run: `cat dist/types/als.d.ts | head -40`
Expected: `AlsSnabditel` class declaration with the same public methods (`run`, `seed`, `resolve`) as before. No new public types exported. Private methods may or may not appear depending on TS emit settings — what matters is no new public surface.

- [ ] **Step 6: Confirm final state**

Run: `git status`
Expected: clean working tree.

Run: `git log --oneline -10`
Expected: the five (or six, if Task 4 produced a commit) refactor commits sit on top of the prior `2c603d5 docs(spec): inline internal/ helpers...` commit.

This task does not produce a commit. If any verification step fails, return to the relevant earlier task and fix the issue there rather than patching at the verification stage.

---

## Acceptance criteria (rolled up from spec)

- [ ] `src/internal/` does not exist; `grep -rn "internal/" src` is empty.
- [ ] `bun run typecheck` is clean.
- [ ] `bun test` is fully green; the seven black-box tests added in Task 1 are present and passing.
- [ ] `bun run build` succeeds; `dist/` has no `internal/` subdirectory under any of `esm/`, `cjs/`, `types/`.
- [ ] No public API change: `index.ts` and `als-index.ts` export the same names as before. No new exports.
- [ ] Every error message in the AlsSnabditel + Snabditel source matches the strings listed in the spec's "Error handling" section verbatim.
- [ ] In `Snabditel`, `singletons`, `localScope`, and `build` are `private`. `getScope()` is gone. `resolve()` is a three-line dispatch.
- [ ] In `AlsSnabditel`, no helper imports from `src/internal/`; `narrower`, `isWider`, `scopeOf`, `ownerName`, `mismatchError`, `effectiveScopedNoRunError`, `writeSeed`, `readSeedToken`, `currentScope` are all `private` instance methods.
