# Review-Response Design (v0.1.0)

**Date:** 2026-05-11
**Source review:** Claude.ai chat snapshot `e3b94cd2-5d95-4628-94b8-b5f7c38bf0b3` — first-pass review of snabditel@0.0.2.

## Goal

Address concrete critiques from the review without expanding the library beyond its intended footprint. Two deliverables:

1. **Disposal** — implement automatic resource cleanup via `Symbol.asyncDispose` / `Symbol.dispose` on cached instances.
2. **README sweep** — name the coupling and async-first tradeoffs, fix the Express recipe, ship a `expressScope` helper, add pronunciation.

Deferred (explicit non-goals this round): typed token<T> helper, full CI workflow, package rename.

## 1. Disposal

### Rationale

The reviewer asked: what happens to scoped instances at `run()` end for DB pools, sockets, AbortControllers? Today: nothing. GC reclaims memory but does not call `.close()`. `WeakMap` does not solve this — it weakens keys not values, requires object keys (string tokens fail), and even if instances could be weakly held, the scoped guarantee ("same instance per run()") would break.

The standard solution in 2026 is TC39 Explicit Resource Management: `Symbol.dispose` / `Symbol.asyncDispose` plus the `using` / `await using` keywords (TS 5.2+, Node 22+). Snabditel inherits this for free by checking the symbols on cached instances.

### Ownership model

Disposal follows **lifetime ownership** — whoever owns the lifetime calls dispose:

| Scope | Owner | Disposal trigger |
|---|---|---|
| `transient` | caller | `await using x = await s.resolve(X)` — runtime calls `[Symbol.asyncDispose]` at block exit |
| `scoped` | container (per-`run()` cache) | container calls `[Symbol.asyncDispose]` LIFO at `run()` exit |
| `singleton` | container (process-wide cache) | container calls on explicit `container.dispose()` |

Why not auto-dispose transients in the container: they are never cached, so the container has no reference to dispose. The caller already holds the only reference; `using` works naturally.

Why not auto-dispose singletons at any implicit trigger: the container's lifetime equals the process for most users. Implicit teardown would surprise. `container.dispose()` is explicit and matches awilix's model.

### Symbol resolution

For each disposable instance:

```
if (typeof v[Symbol.asyncDispose] === "function") await v[Symbol.asyncDispose]();
else if (typeof v[Symbol.dispose] === "function") v[Symbol.dispose]();
else /* skip */
```

Async is preferred when both are present (matches the `await using` precedence in the spec).

### Error semantics

Disposers run to completion; errors are collected, not propagated mid-iteration.

- `run()` body succeeds, all disposers succeed → resolve normally.
- `run()` body succeeds, ≥1 disposer throws → throw `AggregateError(disposeErrs, "disposal failed")`.
- `run()` body throws, all disposers succeed → re-throw the body error.
- `run()` body throws, ≥1 disposer throws → throw `AggregateError([bodyErr, ...disposeErrs], "run() body + disposal failed")`. Body error is `errors[0]`.

The `container.dispose()` path applies the same rules: collect, then aggregate-or-resolve.

### Nested scopes

A child `run()` disposes its own scope on exit. Parent's scope is untouched and continues. Singletons resolved inside a nested run are still tracked on the container's singleton disposable list.

### Idempotency

`container.dispose()` clears `singletons` and resets `singletonDisposables` after running. A second call is a no-op (empty list → no errors → resolves). The container can be re-used after dispose, though typically users dispose once at shutdown.

### Seeded values

Values inserted via `seed()` are not disposed automatically. The user passed in a reference they already own; disposing it would be surprising. Documented explicitly.

### Implementation sketch

**Type change in `snabditel.ts`:**

```ts
type ScopeRecord = {
  cache: Map<Key, unknown>;
  disposables: Array<unknown>; // build-order; iterated reverse for LIFO
};

export type Ctx = { scope: ScopeRecord | null; frame: Frame | null };
```

**New container state:**

```ts
private singletonDisposables: Array<unknown> = [];
```

**Insertion point — `placeIntoCache`:**

After `singletons.set(token, value)` or `builtInScope.set(token, value)`, check if `value` has either dispose symbol. If yes, push onto the matching list (`singletonDisposables` or `record.disposables`).

**`run()` body:**

```ts
async run<T>(cb): Promise<T> {
  const outer = this.outerCtx();
  const record: ScopeRecord = { cache: new Map(), disposables: [] };
  const ctx: Ctx = { scope: record, frame: outer.frame };
  let bodyErr: unknown;
  let result: T | undefined;
  let bodyOk = false;
  try {
    result = await this.wrapAsync(ctx, () => cb(this.makeScoped(ctx)));
    bodyOk = true;
  } catch (e) {
    bodyErr = e;
  }
  const disposeErrs = await this.disposeAll(record.disposables);
  if (!bodyOk) {
    if (disposeErrs.length) {
      throw new AggregateError([bodyErr, ...disposeErrs], "run() body + disposal failed");
    }
    throw bodyErr;
  }
  if (disposeErrs.length) {
    throw new AggregateError(disposeErrs, "disposal failed");
  }
  return result as T;
}
```

**`disposeAll`:**

```ts
private async disposeAll(items: Array<unknown>): Promise<unknown[]> {
  const errs: unknown[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    try {
      const v = items[i] as Record<PropertyKey, unknown>;
      const a = v[Symbol.asyncDispose];
      if (typeof a === "function") {
        await (a as () => Promise<void>).call(v);
        continue;
      }
      const s = v[Symbol.dispose];
      if (typeof s === "function") {
        (s as () => void).call(v);
      }
    } catch (e) {
      errs.push(e);
    }
  }
  return errs;
}
```

**`container.dispose()`:**

```ts
async dispose(): Promise<void> {
  const items = this.singletonDisposables;
  this.singletonDisposables = [];
  const errs = await this.disposeAll(items);
  this.singletons.clear();
  if (errs.length) throw new AggregateError(errs, "singleton disposal failed");
}
```

**`AlsSnabditel`:** no change. Disposal runs inside `run()`, which executes inside the ALS-wrapped frame.

### Tests (`src/snabditel.test.ts` additions)

1. Scoped instance with `Symbol.asyncDispose` disposed at `run()` end.
2. Scoped instance with `Symbol.dispose` (sync) disposed at `run()` end.
3. Both symbols present → async preferred.
4. LIFO order: A built before B → B disposed before A.
5. `run()` body throws → disposers still run → original error re-thrown when no dispose errors.
6. Multiple dispose errors → `AggregateError`.
7. Body error + dispose error → `AggregateError`, body error is `errors[0]`.
8. Nested `run()` → inner disposes on inner exit, outer's instances live until outer exit.
9. `container.dispose()` disposes singletons LIFO; `singletons` map cleared after.
10. Seeded values are not disposed.
11. Transient instances are never cached and never auto-disposed.

## 2. `expressScope` helper

### Rationale

The current README Express recipe is `di.run(async () => next())`. Bug: `next()` returns `void` synchronously, so the `async` callback resolves immediately and the scope closes before downstream middleware runs. The correct pattern anchors the `run()` promise to the response lifecycle, which also gives us per-request disposal for free (DB connections, AbortControllers, etc.).

### API

New subpath export `snabditel/express`. New files: `src/express.ts`, `src/express-index.ts`. No new runtime dependency — the helper types against structural `req`/`res`/`next` shapes; works with Express, also Fastify with shims, anything matching.

```ts
// src/express.ts
import type { AlsSnabditel } from "./als";

type Req = { log?: { error?: (e: unknown) => void } };
type Res = { once: (event: "close", cb: () => void) => void };
type Next = (err?: unknown) => void;

export function expressScope(di: AlsSnabditel) {
  return (req: Req, res: Res, next: Next): void => {
    di.run(async () => {
      next();
      await new Promise<void>((r) => res.once("close", r));
    }).catch((err) => {
      if (req.log?.error) req.log.error(err);
      else console.error("[snabditel/express] scope error:", err);
    });
  };
}
```

```ts
// src/express-index.ts
export { expressScope } from "./express";
```

`package.json` `exports` gains:

```json
"./express": {
  "types": "./dist/types/express-index.d.ts",
  "import": "./dist/esm/express-index.js",
  "require": "./dist/cjs/express-index.js"
}
```

Build scripts add `./src/express-index.ts` to the `bun build` entry list (ESM + CJS); `tsgo` already picks it up via the tsconfig include.

### Why this is correct

1. `next()` runs inside the `run()` callback → inside the ALS frame → downstream middleware see the store via `als.getStore()`. No need to mutate `req`.
2. `res.once("close", ...)` fires for both `finish` and aborted-connection cases. One listener covers normal and abnormal termination. Awaiting it holds the `run()` promise until Express finishes the response.
3. When the promise resolves, `run()` calls `disposeAll` LIFO on per-request scoped instances. Disposal is automatic and idiomatic.
4. Detached `.catch` ensures errors in scope setup or disposal are observable, not lost as unhandled rejections.

### Tests (`src/express.test.ts`)

1. Calls `next()` inside ALS frame (downstream `als.getStore()` is the request scope).
2. Holds scope until `res` emits `"close"`.
3. Disposes scoped instances when response closes.
4. Aggregates and surfaces disposal errors via `req.log?.error` if present, else `console.error`.

## 3. README surgical edits

### 3.1 Header

Below the title add pronunciation line:

```md
**snabditel** · /snahb-dee-TEL/
```

### 3.2 Intro paragraph (above "Features")

```md
Snabditel is a tiny async DI container. Classes own their factory (`static createInstance`); the container owns lifecycle — scope, caching, disposal. No decorators, no `reflect-metadata`, no registration step. Tokens are optional and used only when you need to inject a value rather than a class.
```

Remove "NestJS-inspired" from the existing tagline — invites comparison on features snabditel does not have (modules, providers arrays, hierarchical DI, decorators). Keep the Bulgarian-origin blockquote, it earns its keep.

### 3.3 New "Tradeoffs" section

Insert between "Features" and "Install":

```md
## Tradeoffs

- **Coupling.** `createInstance(s: ASnabditel)` means your class imports a type from the container. The cost of skipping a registration step. Standalone classes prefer awilix.
- **Async-first.** Every `resolve()` returns a Promise. Right for I/O wiring; not usable from sync constructors or sync React render paths.
- **Tokens are optional, not absent.** String/symbol tokens still work via `seed()` for values. The "no tokens" claim refers to classes — those resolve as themselves.
```

### 3.4 Wording fix

Line 10: "no `@Inject()` tokens" → "tokens optional".

### 3.5 Express recipe rewrite

Replace lines 81–118 with:

````md
### Express

`expressScope(di)` opens a fresh DI scope per request, propagates it via `AsyncLocalStorage`, and disposes scoped instances when the response closes.

```ts
// ~/modules/di/server.ts
import { AlsSnabditel } from "snabditel/als";

export const di = new AlsSnabditel();
```

```ts
// app.ts
import express from "express";
import { expressScope } from "snabditel/express";
import { di } from "~/modules/di/server";
import { UserService } from "~/modules/users/server";

const app = express();
app.use(expressScope(di));

app.get("/users", async (_req, res) => {
  const users = await di.resolve(UserService); // sees this request's scope via ALS
  res.json(users.list());
});

app.listen(3000);
```

Long-form pattern (for Fastify, Hono, or custom hooks):

```ts
app.use((req, res, next) => {
  di.run(async () => {
    next();
    await new Promise<void>((r) => res.once("close", r));
  }).catch((err) => req.log?.error?.(err));
});
```
````

### 3.6 New "Disposal" section

Insert under "Concepts" between "Scopes" and "Seeding":

````md
### Disposal

Snabditel auto-disposes cached instances that implement `Symbol.asyncDispose` or `Symbol.dispose`.

```ts
class Db {
  static readonly injectionScope = "scoped";
  static async createInstance() {
    const conn = await connect();
    return new Db(conn);
  }
  constructor(private conn: Conn) {}
  async [Symbol.asyncDispose]() { await this.conn.close(); }
}

await di.run(async (s) => {
  const db = await s.resolve(Db);
  // ... use db ...
}); // db[Symbol.asyncDispose]() called here, LIFO with other scoped instances
```

**Rules:**

- **Scoped** instances: container calls `[Symbol.asyncDispose]` (preferred) or `[Symbol.dispose]` LIFO when the `run()` callback's promise settles, success or rejection.
- **Singletons:** disposed only on explicit `container.dispose()`, LIFO.
- **Transient** instances are never cached, never auto-disposed. Use `await using x = await s.resolve(X)` to dispose them at block exit.
- **Seeded values** are not disposed — the caller owns the lifetime.

If a disposer throws, the others still run. Multiple failures surface as `AggregateError`. If the `run()` body also threw, the body error is `errors[0]`.
````

### 3.7 API section

Append to the `Snabditel` class summary:

```ts
class Snabditel implements ASnabditel {
  // ...
  dispose(): Promise<void>; // disposes singleton instances LIFO
}
```

## 4. Out of scope

- Typed `token<T>(name)` helper for string/symbol tokens (review item #6).
- Concurrent resolve dedup test (review item #5) — `inflight` map already implements this in `snabditel.ts:106-110`; defensive test deferred.
- CI workflow + coverage tooling (review item #3). No new badges added in this round — existing four badges (npm, bundlephobia, deps, types) stay as-is.
- Package rename (review item #2 beyond pronunciation).

## 5. Versioning

Target release: **v0.1.0**. Disposal is a behavior change (cached instances with the dispose symbols now get called automatically), so a minor bump. No breaking type changes; instances without the symbols are unaffected.
