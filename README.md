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

## API

```ts
class Snabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: () => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() + scope inheritance + validation
```
