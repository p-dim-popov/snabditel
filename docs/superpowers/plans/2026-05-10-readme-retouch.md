# README Retouch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `README.md` in popular-library style: hero, features, quick start, framework recipes (Express, TanStack Start, React + React Query), concepts, API, develop, license.

**Architecture:** Single-page README. Full restructure (not additive). Content for sections 5-7 (Concepts, API, Develop) carried over from the existing README with prose tightened. Sections 1-4 and 8 are new.

**Tech Stack:** Markdown only. No library code changes. `package.json` gets one new field (`license`).

**Spec:** `docs/superpowers/specs/2026-05-10-readme-retouch-design.md`.

---

## File Structure

- **Modify:** `README.md` — full rewrite, one file.
- **Modify:** `package.json` — add `license` field.

All work serializes through `README.md`. Per-section commits keep history readable.

## Pre-flight

Three open items from the spec must be resolved before writing the README. Each is its own task. They run sequentially; later tasks consume their outputs.

---

### Task 1: Collect license choice from user

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Inspect current `package.json`**

Read `package.json`. Confirm there is no `license` field.

- [ ] **Step 2: Ask user which license**

Ask: "What license for snabditel? (e.g. MIT, Apache-2.0, ISC)"

Wait for answer. Record verbatim — store as `<LICENSE>` for the rest of the plan.

- [ ] **Step 3: Add `license` to `package.json`**

Edit `package.json`. After the `"version"` line, insert:

```json
  "license": "<LICENSE>",
```

(Substitute `<LICENSE>` with the user's choice.)

- [ ] **Step 4: Verify JSON parses**

Run: `bun -e "JSON.parse(await Bun.file('package.json').text())"`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: add license field to package.json"
```

---

### Task 2: Measure bundle size

**Files:** none modified.

- [ ] **Step 1: Build the package**

Run: `bun run build`
Expected: exits 0, populates `dist/esm/` and `dist/cjs/`.

- [ ] **Step 2: Measure ESM minzip size**

Run:
```bash
gzip -c dist/esm/index.js dist/esm/als-index.js | wc -c
```
Expected: a number in bytes. Convert to nearest 0.1 kB. Record as `<MINZIP_SIZE>`.

- [ ] **Step 3: Decide bullet treatment**

If `<MINZIP_SIZE>` ≤ 5 kB, keep the "Tiny" bullet with the measured number. If > 5 kB, drop the bullet from the Features section (the spec's escape clause).

Record decision as `<KEEP_TINY_BULLET>` (`yes` / `no`) and `<MINZIP_SIZE>`.

No commit — this task only produces values for later tasks.

---

### Task 3: Verify TanStack Start middleware API

**Files:** none modified.

- [ ] **Step 1: Fetch current TanStack Start docs**

Use the `mcp__plugin_context7_context7__query-docs` tool. Resolve library ID for `@tanstack/start` first via `mcp__plugin_context7_context7__resolve-library-id`, then query docs for "server middleware createMiddleware createServerFileRoute".

- [ ] **Step 2: Compare to spec snippet**

Spec section 4b uses:
```ts
import { createMiddleware } from "@tanstack/start";
// ...
export const diMiddleware = createMiddleware().server(({ next }) =>
  di.run(() => next()),
);

export const Route = createServerFileRoute("/users").methods({
  GET: async () => { /* ... */ },
}).middleware([diMiddleware]);
```

For each name (`createMiddleware`, the `.server()` chaining, `next` callback shape, `createServerFileRoute`, `.methods({})`, `.middleware([])`), confirm against fetched docs:
- name and import path match
- argument shape matches
- middleware attachment mechanism matches

- [ ] **Step 3: Record corrected snippet**

If anything differs, write the corrected snippet to a scratch note (in your task notes — not in the README yet). The corrected version replaces the spec snippet in Task 7.

If everything matches, record "spec snippet correct as-is."

No commit.

---

## README rewrite

Each section is its own task. The README is rebuilt section by section, top to bottom, replacing the existing content as we go.

**Strategy:** Task 4 truncates the README to just the new top-of-file scaffold. Tasks 5-12 append each section. This avoids one giant Edit and gives reviewable per-section commits.

---

### Task 4: Truncate README to scaffold

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write scaffold**

Replace the entire contents of `README.md` with the following placeholder. This is intentionally short — sections are appended in later tasks.

```markdown
<!-- WIP: rewrite in progress, see docs/superpowers/plans/2026-05-10-readme-retouch.md -->
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): start retouch (scaffold)"
```

---

### Task 5: Section 1 — Hero

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace scaffold with hero**

Replace the entire contents of `README.md` with:

```markdown
# snabditel

[![npm version](https://img.shields.io/npm/v/snabditel.svg)](https://www.npmjs.com/package/snabditel)
[![bundle size](https://img.shields.io/bundlephobia/minzip/snabditel)](https://bundlephobia.com/package/snabditel)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/snabditel)
[![types](https://img.shields.io/npm/types/snabditel)](https://www.npmjs.com/package/snabditel)

Tiny async DI for TypeScript. Zero deps.

> Снабдител — Bulgarian for "supplier". Supplies your services with their dependencies, and you with your services.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): hero section (badges + tagline)"
```

---

### Task 6: Section 2 — Features

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append Features section**

Append the following to the end of `README.md`. If `<KEEP_TINY_BULLET>` from Task 2 is `no`, drop the second bullet entirely.

```markdown

## Features

- **Zero runtime dependencies.**
- **Tiny.** ~<MINZIP_SIZE> kB minzipped.
- **Async-first.** `resolve()` returns a Promise — no sync/async split.
- **Three scopes.** `singleton`, `transient`, `scoped`.
- **Concurrent-safe.** `AlsSnabditel` uses `AsyncLocalStorage` — parallel `run()` calls don't leak state.
- **Scope inference + validation.** Effective scope = narrowest dep. Mismatches throw at first resolve.
- **Cycle detection.** Caught at resolve time.
- **TS types built-in. ESM + CJS.**
```

(Substitute `<MINZIP_SIZE>` with the value from Task 2.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): features bullets"
```

---

### Task 7: Section 3 — Install + Quick start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append Install + Quick start**

Append the following to `README.md`:

````markdown

## Install

```bash
npm install snabditel
pnpm add snabditel
yarn add snabditel
bun add snabditel
```

## Quick start

```ts
import { Snabditel } from "snabditel";

const di = new Snabditel();

class Logger {
  info(msg: string) { console.log(msg); }
}

class UserService {
  static readonly injectionScope = "scoped";
  static async createInstance() {
    return new UserService(await di.resolve(Logger));
  }
  constructor(private logger: Logger) {}
  greet(name: string) { this.logger.info(`hello ${name}`); }
}

await di.run(async () => {
  const users = await di.resolve(UserService);
  users.greet("ada");
});
```

`UserService` declares its deps via `createInstance` — `Logger` resolves automatically. `scoped` means each `run()` (e.g. each request) gets a fresh `UserService`; `Logger` stays singleton.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): install + quick start"
```

---

### Task 8: Section 4a — Express recipe

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append Recipes header + Express subsection**

Append to `README.md`:

````markdown

## Recipes

### Express

Wrap each request in a fresh DI scope using `AlsSnabditel`.

```ts
import express from "express";
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class UserService {
  static readonly injectionScope = "scoped" as const;
  static createInstance() { return new UserService(); }
  list() { return [{ id: 1, name: "ada" }]; }
}

const app = express();

app.use((_req, _res, next) => {
  di.run(async () => next());
});

app.get("/users", async (_req, res) => {
  const users = await di.resolve(UserService);
  res.json(users.list());
});

app.listen(3000);
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): recipes section + Express example"
```

---

### Task 9: Section 4b — TanStack Start recipe

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append TanStack Start subsection**

Append to `README.md`. If Task 3 produced a corrected snippet, use that instead of the version below.

````markdown

### TanStack Start

Server middleware wraps `next()` in `di.run()`. Same `AlsSnabditel` pattern as Express.

```ts
import { createMiddleware } from "@tanstack/start";
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class UserService {
  static readonly injectionScope = "scoped" as const;
  static createInstance() { return new UserService(); }
  list() { return [{ id: 1 }]; }
}

export const diMiddleware = createMiddleware().server(({ next }) =>
  di.run(() => next()),
);

export const Route = createServerFileRoute("/users").methods({
  GET: async () => {
    const users = await di.resolve(UserService);
    return Response.json(users.list());
  },
}).middleware([diMiddleware]);
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): TanStack Start recipe"
```

---

### Task 10: Section 4c — React + React Query recipe

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append React subsection**

Append to `README.md`:

````markdown

### React + React Query

Browser side. Base `Snabditel` with module-level singletons. No `run()` — base `Snabditel` is single-flight, and React Query fires queries in parallel. `Api` handles auth + base URL via `AppConfig`. `UsersClient` depends on `Api`. `useQuery` consumes `queryOptions` that resolve `UsersClient`.

```ts
// di.ts
import { Snabditel } from "snabditel";

export const di = new Snabditel();

export class AppConfig {
  static createInstance() {
    return new AppConfig({ backendUrl: import.meta.env.VITE_BACKEND_URL });
  }
  constructor(private cfg: { backendUrl: string }) {}
  get backendUrl() { return this.cfg.backendUrl; }
}

export class Api {
  static async createInstance() {
    return new Api(await di.resolve(AppConfig));
  }
  constructor(private config: AppConfig) {}
  async request(path: string, init?: RequestInit) {
    const token = await this.authToken();
    return fetch(`${this.config.backendUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  }
  private async authToken() { /* lookup */ return ""; }
}

export class UsersClient {
  static async createInstance() {
    return new UsersClient(await di.resolve(Api));
  }
  constructor(private api: Api) {}
  list() { return this.api.request("/users").then((r) => r.json()); }
  get(id: string) { return this.api.request(`/users/${id}`).then((r) => r.json()); }
}
```

```ts
// users.queries.ts
import { queryOptions } from "@tanstack/react-query";
import { di, UsersClient } from "./di";

export const usersQueryOptions = queryOptions({
  queryKey: ["users"],
  queryFn: async () => {
    const users = await di.resolve(UsersClient);
    return users.list();
  },
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

For per-query scoping in the browser, swap to `AlsSnabditel` and use a runtime that supports `AsyncLocalStorage` (or polyfill).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): React + React Query recipe"
```

---

### Task 11: Section 5 — Concepts

**Files:**
- Modify: `README.md`

This task carries the existing README's `## Tokens`, `## Scopes`, and `## Seeding` content into the new structure under `## Concepts`. Code examples are kept verbatim. Prose is tightened: drop redundant connectives, merge repeated explanations, no example or rule removed. Also fold the existing standalone `## Concurrent scopes (AlsSnabditel)` block into the Scopes subsection.

- [ ] **Step 1: Append Concepts header + Tokens**

Append to `README.md`:

````markdown

## Concepts

### Tokens

Anything resolvable:

- **Plain class** — `new ()` constructor with no deps. Default scope: singleton.
- **Class with static `createInstance` (and optional `injectionScope`)** — class itself acts as a `SelfResolvable`. Use when class has deps or async setup.
- **String / symbol** — must be `seed()`-ed first. Use sparingly (config, request context).

#### Class with async init

```ts
class Database {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    const connectionString = config.get("db.connectionString");
    const connection = await connect(connectionString);
    return new Database(connection);
  }

  constructor(public conn: unknown) {}
}

const db = await di.resolve(Database);
```

#### Swapping an implementation

```ts
class Mailer {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    const mailerConfig = config.get('mailer');
    const provider = await (async () => {
      switch (mailerConfig.provider) {
        case "smtp": return di.resolve(SmtpMailerProvider);
        case "fake": return di.resolve(FakeMailerProvider);
        default: throw new Error("Unknown mailer provider");
      }
    })()
    return new Mailer(provider);
  }

  constructor(private readonly provider: MailerProvider) {}

  send(to: string): {
    // ...
  }
}

interface MailerProvider {
  send(to: string): Promise<void>;
}

class SmtpMailerProvider implements MailerProvider { async send(to: string) { /* ... */ } }
class FakeMailerProvider implements MailerProvider { async send(_: string) {} }

const mailer = await di.resolve(Mailer); // SmtpMailer or FakeMailer based on config
```

#### Using a factory

```ts
class MailerProviderFactory {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    return new MailerProviderFactory(config);
  }

  constructor(private readonly config: AppConfig) {}

  create() {
    const mailerConfig = this.config.get('mailer');
    switch (mailerConfig.provider) {
      case "smtp": return di.resolve(SmtpMailerProvider);
      case "fake": return di.resolve(FakeMailerProvider);
      default: throw new Error("Unknown mailer provider");
    }
  }
}

class Mailer {
  static async createInstance() {
    const mailerProviderFactory = await di.resolve(MailerProviderFactory);
    const provider = await mailerProviderFactory.create();
    return new Mailer(provider);
  }

  constructor(private readonly provider: MailerProvider) {}

  send(to: string): {
    // ...
  }
}
```

#### Non-class values

Strings/symbols work for plain config or request data — DI still tracks lifetime:

```ts
di.seed("CFG", { apiUrl: "https://api.example.com" });
const cfg = await di.resolve<{ apiUrl: string }>("CFG");
```
````

- [ ] **Step 2: Append Scopes**

Append to `README.md`:

````markdown

### Scopes

| Scope | Behavior |
|-------|----------|
| `singleton` | Cached forever in container. Default. |
| `transient` | New instance every `resolve()`. Cannot be `seed()`-ed. |
| `scoped` | Cached per `run()`. Requires active scope. |

```ts
class RequestContext {
  static readonly injectionScope = "scoped";
  static createInstance() { return new RequestContext(); }

  id = crypto.randomUUID();
}

await di.run(async () => {
  const a = await di.resolve(RequestContext);
  const b = await di.resolve(RequestContext);
  // a === b — same instance for the whole run
});
```

#### Scope inheritance and validation (`AlsSnabditel`)

In `AlsSnabditel`, a token's effective scope is the narrowest scope of its dependencies when `injectionScope` is omitted, and an explicit `injectionScope` that is wider than its narrowest dependency throws at resolve time.

Lifetime ordering, narrowest to widest: `transient` → `scoped` → `singleton`.

```ts
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class RequestId {
  static readonly injectionScope = "scoped" as const;
  static createInstance() { return new RequestId(); }
  id = crypto.randomUUID();
}

class UserService {
  // No injectionScope. Effective scope = scoped (inherited from RequestId).
  static async createInstance() {
    const req = await di.resolve(RequestId);
    return new UserService(req);
  }
  constructor(private req: RequestId) {}
}

class BadCache {
  static readonly injectionScope = "singleton" as const;
  static async createInstance() {
    await di.resolve(RequestId);    // throws: declared singleton, dep is scoped
    return new BadCache();
  }
}
```

Inference and validation are first-resolve operations. Once a token is cached, subsequent resolves do not re-evaluate. Base `Snabditel` does not implement inheritance or validation; declared `injectionScope` is taken as-is.

#### Concurrent scopes (`AlsSnabditel`)

Base `Snabditel` has single-flight `run()` — nested or concurrent `run()` throws. For parallel requests use the ALS variant:

```ts
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class RequestHandler {
  static async createInstance() {
    return new RequestHandler(await di.resolve(Logger));
  }

  constructor(private logger: Logger) {}
  async handle(req: Request) { /* resolve scoped deps freely */ }
}

await Promise.all([
  di.run(async () => {
    const h = await di.resolve(RequestHandler);
    return h.handle(req1);
  }),
  di.run(async () => {
    const h = await di.resolve(RequestHandler);
    return h.handle(req2);
  }),
]);
// each run() gets its own scope; no leak across awaits
```

The `snabditel/als` subpath exists so `node:async_hooks` only loads when imported.
````

- [ ] **Step 3: Append Seeding**

Append to `README.md`:

````markdown

### Seeding

Pre-populate values by class, string, or symbol token. Useful for test doubles and per-request data.

```ts
// Override a class with a fake — great for tests
const fakeLogger: Logger = { info: () => {} } as Logger;
di.seed(Logger, fakeLogger);

// Per-run scoped data (e.g. current user)
class CurrentUser { constructor(public id: string) {} }

await di.run(async () => {
  di.seed(CurrentUser, new CurrentUser("u_123"), { injectionScope: "scoped" });
  const user = await di.resolve(CurrentUser);
});
```

Scoped seeds shadow singleton seeds inside `run()`. A `transient` seed throws.
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): concepts (tokens, scopes, seeding)"
```

---

### Task 12: Section 6 — API

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append API section**

Append to `README.md`:

````markdown

## API

```ts
class Snabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: () => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() + scope inheritance + validation
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): API section"
```

---

### Task 13: Section 7 — Develop

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append Develop section**

Append to `README.md`:

````markdown

## Develop

```bash
bun install
bun test
bun run typecheck
bun run build
```

Source written for Bun, but the published package targets Node and runs anywhere ESM/CJS does.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): develop section"
```

---

### Task 14: Section 8 — License

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append License section**

Append to `README.md`. Substitute `<LICENSE>` with the license string from Task 1.

```markdown

## License

<LICENSE>
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): license section"
```

---

## Verification

### Task 15: Final review

**Files:** none modified (verification only).

- [ ] **Step 1: Read the full README**

Run: cat is fine for verification, but use the Read tool on `README.md` to inspect the rendered file.

Confirm the section order matches the spec:
1. Title + badges + tagline + Bulgarian aside
2. Features
3. Install
4. Quick start
5. Recipes (Express, TanStack Start, React + React Query)
6. Concepts (Tokens, Scopes, Seeding)
7. API
8. Develop
9. License

- [ ] **Step 2: Sanity-check fenced code blocks**

Run:
```bash
grep -c '^```' README.md
```
Expected: an even number (every fence opens and closes).

- [ ] **Step 3: Confirm no stale references**

Run:
```bash
grep -n 'WIP\|TODO\|TBD\|<MINZIP_SIZE>\|<LICENSE>\|<KEEP_TINY_BULLET>' README.md
```
Expected: no matches.

If any match, fix inline and amend the relevant section's commit (or add a fix-up commit).

- [ ] **Step 4: Render check on GitHub**

Push the branch and visually inspect the README on the GitHub PR view. Confirm:
- All four badges render (or show the placeholder shield).
- Code blocks are syntax-highlighted.
- Tables render.
- No broken links.

If any visual issue, fix and add a follow-up commit.

- [ ] **Step 5: Run full project checks**

Run:
```bash
bun run typecheck
bun test
```
Expected: both pass. (No library code changed, so this is a paranoia check that the `package.json` edit didn't break anything.)

No commit on this task unless fixes are needed.

---

## Decisions log (carried from spec)

- Full restructure, not additive.
- Tone: serious-confident-punchy.
- Single-page README; no separate docs files.
- Badges: npm version, bundle size, zero deps, TS types. No CI badge.
- Recipe depth: ~15-25 lines minimal. React recipe split across three files per user request.
- Server recipes use `AlsSnabditel`; React uses base `Snabditel` with module-level singletons (avoids base single-flight conflict with concurrent React Query queries).
- No injection-scope tweaks in React recipe.
