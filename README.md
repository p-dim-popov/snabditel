# snabditel

[![npm version](https://img.shields.io/npm/v/snabditel.svg)](https://www.npmjs.com/package/snabditel)
[![bundle size](https://img.shields.io/bundlephobia/minzip/snabditel)](https://bundlephobia.com/package/snabditel)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/p-dim-popov/snabditel)
[![types](https://img.shields.io/npm/types/snabditel)](https://www.npmjs.com/package/snabditel)

Tiny async DI for TypeScript. Zero deps.

> Снабдител — Bulgarian for "supplier". Supplies your services with their dependencies, and you with your services.

## Features

- **Zero runtime dependencies.**
- **Tiny.** ~2.4 kB minzipped.
- **Async-first.** `resolve()` returns a Promise — no sync/async split.
- **Three scopes.** `singleton`, `transient`, `scoped`.
- **Concurrent-safe by default.** Base `Snabditel` supports parallel `run()` scopes via an explicit scope-bound resolver — works in the browser, no `node:async_hooks`. `AlsSnabditel` (subpath `snabditel/als`, node-only) adds implicit propagation for callers who want to skip threading the resolver.
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
import { Snabditel, type ASnabditel } from "snabditel";

const di = new Snabditel();

class Logger {
  info(msg: string) { console.log(msg); }
}

class UserService {
  static readonly injectionScope = "scoped";
  static async createInstance(s: ASnabditel) {
    return new UserService(await s.resolve(Logger));
  }
  constructor(private logger: Logger) {}
  greet(name: string) { this.logger.info(`hello ${name}`); }
}

await di.run(async (s) => {
  const users = await s.resolve(UserService);
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

Register the DI scope as **global request middleware** in `src/start.ts`. This wraps every request (server routes, SSR, server functions) in a fresh `di.run` scope. ALS propagates the scope implicitly, so handlers keep using module-level `di.resolve(...)`.

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

const users = await di.resolve(UserService); // sees the request's scope via ALS
```

Use `functionMiddleware` instead of `requestMiddleware` to limit the scope to server-function calls only.

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

await di.run(async (s) => {
  const a = await s.resolve(RequestContext);
  const b = await s.resolve(RequestContext);
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

Inference and validation are first-resolve operations. Once a token is cached, subsequent resolves do not re-evaluate. Both `Snabditel` and `AlsSnabditel` share this engine.

#### Concurrent scopes

Both flavors handle parallel `run()` calls. Base `Snabditel` requires the explicit `s` resolver passed to `run`'s callback (and to `createInstance`); `AlsSnabditel` propagates it implicitly via `AsyncLocalStorage`.

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
// each run() gets isolated scope; no leak between siblings.
```

`AlsSnabditel` (subpath `snabditel/als`) extends this with implicit `s` propagation, so callbacks and `createInstance` may ignore the `s` arg. The subpath is separate so `node:async_hooks` only loads when imported.

### Seeding

Pre-populate values by class, string, or symbol token. Useful for test doubles and per-request data.

```ts
// Override a class with a fake — great for tests
const fakeLogger: Logger = { info: () => {} } as Logger;
di.seed(Logger, fakeLogger);

// Per-run scoped data (e.g. current user)
class CurrentUser { constructor(public id: string) {} }

await di.run(async (s) => {
  s.seed(CurrentUser, new CurrentUser("u_123"), { injectionScope: "scoped" });
  const user = await s.resolve(CurrentUser);
});
```

Scoped seeds shadow singleton seeds inside `run()`. A `transient` seed throws.

## API

```ts
class Snabditel implements ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
}

class AlsSnabditel implements ASnabditel {} // ALS-backed run() — s arg optional in practice; same inheritance + validation
```

## Develop

```bash
bun install
bun test
bun run typecheck
bun run build
```

Source written for Bun, but the published package targets Node and runs anywhere ESM/CJS does.

## License

MIT
