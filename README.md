# snabditel

[![npm version](https://img.shields.io/npm/v/snabditel.svg)](https://www.npmjs.com/package/snabditel)
[![bundle size](https://img.shields.io/bundlephobia/minzip/snabditel)](https://bundlephobia.com/package/snabditel)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/snabditel)
[![types](https://img.shields.io/npm/types/snabditel)](https://www.npmjs.com/package/snabditel)

Tiny async DI for TypeScript. Zero deps.

> Снабдител — Bulgarian for "supplier". Supplies your services with their dependencies, and you with your services.

## Features

- **Zero runtime dependencies.**
- **Tiny.** ~2.4 kB minzipped.
- **Async-first.** `resolve()` returns a Promise — no sync/async split.
- **Three scopes.** `singleton`, `transient`, `scoped`.
- **Concurrent-safe.** `AlsSnabditel` uses `AsyncLocalStorage` — parallel `run()` calls don't leak state.
- **Scope inference + validation.** Effective scope = narrowest dep. Mismatches throw at first resolve.
- **Cycle detection.** Caught at resolve time.
- **TS types built-in. ESM + CJS.**

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

### TanStack Start

Server middleware wraps `next()` in `di.run()`. Same `AlsSnabditel` pattern as Express.

```ts
import { createMiddleware } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/users")({
  server: {
    middleware: [diMiddleware],
    handlers: {
      GET: async () => {
        const users = await di.resolve(UserService);
        return Response.json(users.list());
      },
    },
  },
});
```

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
```
