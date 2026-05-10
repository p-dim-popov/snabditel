# README retouch — design

Date: 2026-05-10
Status: Draft (awaiting user review)

## Goal

Rebuild `README.md` in popular-library style. Keep all current technical content (Tokens / Scopes / Seeding / API), restructure for scannability, add a recipes section with TanStack Start, Express, and React + React Query examples.

Tone: serious-confident-punchy (between Express-style neutral docs and Hono/tRPC-style opinionated). No jokes, no fluff.

Single-page README. No external docs site.

## Out of scope

- Logo / artwork.
- Setting up CI badges (no CI workflow yet — only static badges from npm/bundlephobia/shields).
- Publishing to npm or measuring real bundle size beyond placeholder.
- Separate `docs/*.md` files for concepts.

## Structure

```
1. Hero            — title, badges, tagline, Bulgarian aside
2. Features        — 6-8 bullets
3. Quick start     — install + 30-sec example
4. Recipes         — Express, TanStack Start, React + React Query
5. Concepts        — Tokens, Scopes, Seeding (current content, compressed)
6. API             — type signatures
7. Develop         — bun install / test / typecheck / build
8. License         — line
```

## Section detail

### 1. Hero

```markdown
# snabditel

[![npm version](https://img.shields.io/npm/v/snabditel.svg)](https://npmjs.com/package/snabditel)
[![bundle size](https://img.shields.io/bundlephobia/minzip/snabditel)](https://bundlephobia.com/package/snabditel)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/petar-popov/snabditel)
[![types](https://img.shields.io/npm/types/snabditel)](https://npmjs.com/package/snabditel)

Tiny async DI for TypeScript. Zero deps.

> Снабдител — Bulgarian for "supplier". Supplies your services with their dependencies, and you with your services.
```

Badge URLs are illustrative. Implementer verifies the actual repo slug and shields paths before commit.

### 2. Features

```markdown
## Features

- **Zero runtime dependencies.**
- **Tiny.** ~Xkb minzipped.
- **Async-first.** `resolve()` returns a Promise — no sync/async split.
- **Three scopes.** `singleton`, `transient`, `scoped`.
- **Concurrent-safe.** `AlsSnabditel` uses `AsyncLocalStorage` — parallel `run()` calls don't leak state.
- **Scope inference + validation.** Effective scope = narrowest dep. Mismatches throw at first resolve.
- **Cycle detection.** Caught at resolve time.
- **TS types built-in. ESM + CJS.**
```

`Xkb` is a placeholder. Implementer measures `dist/esm/*.js` (gzip) before publish and substitutes the number, or removes the bullet if measurement is deferred.

### 3. Quick start

```markdown
## Install

\`\`\`bash
npm install snabditel
pnpm add snabditel
yarn add snabditel
bun add snabditel
\`\`\`

## Quick start

\`\`\`ts
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
\`\`\`

`UserService` declares its deps via `createInstance` — `Logger` resolves automatically. `scoped` means each `run()` (e.g. each request) gets a fresh `UserService`; `Logger` stays singleton.
```

### 4. Recipes

Three subsections. Each ~15-30 lines except React (split across three files).

#### 4a. Express middleware

`AlsSnabditel`. Wrap each request in `di.run()`.

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

#### 4b. TanStack Start middleware

`AlsSnabditel`. Server middleware wraps `next()` in `di.run()`.

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

**Open item for implementation:** verify exact TanStack Start middleware API (`createMiddleware`, `createServerFileRoute` shape, middleware attachment) against current docs via context7. Adjust the snippet to match the released API.

#### 4c. React + React Query

Base `Snabditel`. Module-level container. Three files: `di.ts`, `users.queries.ts`, `Users.tsx`. `Api` handles auth + base URL via `AppConfig`. `UsersClient` depends on `Api`. `useQuery` uses `queryOptions` that resolve `UsersClient`.

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

Note: base `Snabditel` is single-flight — concurrent `run()` throws. The example sticks to module-level singletons, no `run()`. For per-query scoping in the browser, swap to `AlsSnabditel` (and use a runtime that supports `AsyncLocalStorage`, or polyfill).

### 5. Concepts

Reuse current README's `## Tokens`, `## Scopes`, `## Seeding` sections. Code examples kept verbatim. Prose may be tightened (drop redundant connectives, merge repeated explanations) but no example, decision, or rule is removed.

- 5a Tokens — three kinds: plain class / class with `createInstance` (+ optional `injectionScope`) / string|symbol via `seed()`. Keep current `Class with async init`, `Swapping an implementation`, `Using factory`, `Non-class values` examples.
- 5b Scopes — keep current scope table, current `RequestContext` example, current `### Scope inheritance and validation (AlsSnabditel)` block including `RequestId` / `UserService` / `BadCache` example. Move the standalone `## Concurrent scopes (AlsSnabditel)` example into this subsection (scope inheritance is the AlsSnabditel feature; concurrent `run()` is the AlsSnabditel runtime story — both belong together).
- 5c Seeding — keep current `Seeding` section verbatim (fake `Logger`, `CurrentUser` per-run example, scoped-shadows-singleton sentence).

### 6. API

Keep current `## API` block. No change.

```ts
class Snabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: () => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() + scope inheritance + validation
```

### 7. Develop

Keep current `## Develop` block verbatim (`bun install` / `bun test` / `bun run typecheck` / `bun run build` and the Bun-vs-Node note).

### 8. License

Add line. `package.json` currently has no `license` field. Implementer asks user to pick a license, adds it to `package.json`, lists it in README.

## Decisions log

- **Full restructure** of README, not additive.
- **Tone:** serious-confident-punchy. No jokes.
- **Single-page README** — deep content stays at bottom; no separate docs/*.md.
- **Badges:** npm version, bundle size, zero deps, TS types. No CI badge yet.
- **Recipe depth:** ~15-25 lines minimal snippet per recipe. React recipe split across three files because user asked for `Api` + `UsersClient` + `queryOptions` shape.
- **Server recipes use `AlsSnabditel`.** React recipe uses base `Snabditel` with module-level singletons, no per-query `run()` (resolves the base-Snabditel single-flight conflict with concurrent React Query queries).
- **No injection-scope tweaks** in React recipe (user dropped earlier `transient` idea after the stale-capture issue surfaced).

## Open items for implementation phase

1. Verify TanStack Start middleware API shape (`createMiddleware`, `createServerFileRoute`) via context7 against current released docs.
2. Measure `dist/esm` minzip size and substitute `Xkb` placeholder, or remove the bullet.
3. Verify shields.io badge URLs against the actual published package + repo slug.
4. Confirm license line and ensure `package.json` `license` field matches.

## Verification

- README renders correctly on GitHub (manual visual check).
- All code blocks compile against current `snabditel` API: `Snabditel`, `AlsSnabditel`, `resolve`, `seed`, `run`, `injectionScope`, `createInstance`. (No code change to library; if any snippet relies on a method not in the public API, fix the snippet, not the library.)
- No external doc files referenced.
- All current README examples preserved in section 5 (Concepts).
