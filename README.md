# snabditel

**snabditel** · /snahb-dee-TEL/

[![npm version](https://img.shields.io/npm/v/snabditel.svg)](https://www.npmjs.com/package/snabditel)
[![bundle size](https://img.shields.io/bundlephobia/minzip/snabditel)](https://bundlephobia.com/package/snabditel)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/p-dim-popov/snabditel)
[![types](https://img.shields.io/npm/types/snabditel)](https://www.npmjs.com/package/snabditel)

Tiny async DI container — no ceremonies. Zero deps.

Snabditel is a tiny async DI container. Classes own their factory (`static createInstance`); the container owns lifecycle — scope, caching, disposal. No decorators, no `reflect-metadata`, no registration step. Tokens are optional and used only when you need to inject a value rather than a class.

> Снабдител — Bulgarian for "supplier". Supplies your services with their dependencies, and you with your services.

## Features

- **Zero runtime dependencies.**
- **Async-first.** `resolve()` returns a Promise — no sync/async split.
- **Three scopes.** `singleton`, `transient`, `scoped`.
- **Concurrent-safe by default.** Base `Snabditel` supports parallel `run()` scopes via an explicit scope-bound resolver — works in the browser, no `node:async_hooks`. `AlsSnabditel` (subpath `snabditel/als`, node-only) adds implicit propagation for callers who want to skip threading the resolver.
- **Scope inference + validation.** Effective scope = narrowest dep. Mismatches throw at first resolve.
- **Cycle detection.** Caught at resolve time.
- **TS types built-in. ESM + CJS.**

## Tradeoffs

- **Coupling.** `createInstance(s: ASnabditel)` means your class imports a type from the container. The cost of skipping a registration step. Standalone classes prefer awilix.
- **Async-first.** Every `resolve()` returns a Promise. Right for I/O wiring; not usable from sync constructors or sync React render paths.
- **Tokens are optional, not absent.** String/symbol tokens still work via `seed()` for values. The "no tokens" claim refers to classes — those resolve as themselves.

## Install

```bash
# pick one
npm install snabditel
pnpm add snabditel
yarn add snabditel
bun add snabditel
```

## Quick start

Explicit scopes are only needed when you want to override the inferred default — most classes can omit `injectionScope` entirely.

```ts
// ~/modules/di/server.ts
import { Snabditel } from "snabditel";

export const di = new Snabditel();
```

```ts
// ~/modules/logger/logger.ts
export class Logger {
  info(msg: string) { console.log(msg); }
}
```

```ts
// ~/modules/users/user.service.ts
import type { ASnabditel } from "snabditel";
import { Logger } from "~/modules/logger/server";

export class UserService {
  static async createInstance(s: ASnabditel) {
    return new UserService(await s.resolve(Logger));
  }
  constructor(private logger: Logger) {}
  greet(name: string) { this.logger.info(`hello ${name}`); }
}
```

```ts
// app.ts
import { di } from "~/modules/di/server";
import { UserService } from "~/modules/users/server";

await di.run(async (s) => {
  const users = await s.resolve(UserService);
  users.greet("ada");
});
```

`UserService` declares its deps via `createInstance` — `Logger` resolves automatically. With no `injectionScope` declared, the effective scope is inferred from dependencies. The `s` arg is the scope-bound resolver `di.run` provides — thread it into nested `s.resolve(...)` calls.

## Recipes

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

### TanStack Start

Register the DI scope as **global request middleware** in `src/start.ts`. This wraps every request (server routes, SSR, server functions) in a fresh `di.run` scope. ALS propagates the scope implicitly, so handlers keep using module-level `di.resolve(...)`.

```ts
// ~/modules/di/server.ts
import { AlsSnabditel } from "snabditel/als";

export const di = new AlsSnabditel();
```

```ts
// ~/modules/users/user.service.ts
export class UserService {
  static createInstance() { return new UserService(); }
  list() { return [{ id: 1 }]; }
}
```

```ts
// src/start.ts
import { createStart, createMiddleware } from "@tanstack/react-start";
import { di } from "~/modules/di/server";

const diMiddleware = createMiddleware().server(({ next }) =>
  di.run(() => next()),
);

export const startInstance = createStart(() => ({
  requestMiddleware: [diMiddleware],
}));
```

```ts
// any server route, server function, or loader
import { di } from "~/modules/di/server";
import { UserService } from "~/modules/users/server";

const users = await di.resolve(UserService); // sees the request's scope via ALS
```

Use `functionMiddleware` instead of `requestMiddleware` to limit the scope to server-function calls only.

### React + React Query

Browser side. Each `queryFn` opens its own `di.run(s => ...)` — concurrent runs are safe in base `Snabditel`.

```ts
// ~/modules/di/client.ts
import { Snabditel } from "snabditel";

export const di = new Snabditel();
```

```ts
// ~/modules/config/app-config.ts
type ConfigShape = { backendUrl: string };

export class AppConfig {
  static createInstance() {
    return new AppConfig({ backendUrl: import.meta.env.VITE_BACKEND_URL });
  }
  constructor(private cfg: ConfigShape) {}
  get<K extends keyof ConfigShape>(key: K): ConfigShape[K] {
    return this.cfg[key];
  }
}
```

```ts
// ~/modules/api/api.ts
import type { ASnabditel } from "snabditel";
import { AppConfig } from "~/modules/config/client";

export class Api {
  static readonly injectionScope = "scoped"; // one Api per query run; AppConfig stays singleton
  static async createInstance(s: ASnabditel) {
    return new Api(await s.resolve(AppConfig));
  }
  constructor(private config: AppConfig) {}
  request(path: string, init?: RequestInit) {
    return fetch(`${this.config.get("backendUrl")}${path}`, init);
  }
}
```

```ts
// ~/modules/users/users.client.ts
import type { ASnabditel } from "snabditel";
import { Api } from "~/modules/api/client";

export class UsersClient {
  static async createInstance(s: ASnabditel) {
    return new UsersClient(await s.resolve(Api));
  }
  constructor(private api: Api) {}
  list() { return this.api.request("/users").then((r) => r.json()); }
}
```

```ts
// ~/modules/users/users.queries.ts
import { queryOptions } from "@tanstack/react-query";
import { di } from "~/modules/di/client";
import { UsersClient } from "./users.client";

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
import { useSuspenseQuery } from "@tanstack/react-query";
import { usersQueryOptions } from "~/modules/users/client";

export function Users() {
  const { data } = useSuspenseQuery(usersQueryOptions);
  return <ul>{data.map((user) => <li key={user.id}>{user.name}</li>)}</ul>;
}
```

Propagation: `queryFn` opens scope → `s.resolve(UsersClient)` (inferred scoped) → `UsersClient.createInstance(s)` → `s.resolve(Api)` (scoped, cached on `s`) → `Api.createInstance(s)` → `s.resolve(AppConfig)` (singleton, root cache). Two parallel `useSuspenseQuery`s = two parallel `di.run`s = two isolated `Api` instances; `AppConfig` shared. All in browser, no `node:async_hooks`.

## Concepts

Examples below use module-level `di` for brevity. Under base `Snabditel`, accept `s: ASnabditel` in `createInstance` and call `s.resolve(...)` instead — same pattern as the recipes.

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
    const connection = await connect(config.get("db.connectionString"));
    return new Database(connection);
  }
  constructor(public conn: unknown) {}
}

const db = await di.resolve(Database);
```

#### Non-class values

Strings/symbols work for plain config or request data — DI still tracks lifetime:

```ts
di.seed("CFG", { apiUrl: "https://api.example.com" });
const cfg = await di.resolve<{ apiUrl: string }>("CFG");
```

#### Swapping an implementation

Real example: pick between SMTP (nodemailer) and SendGrid based on config.

```ts
import nodemailer, { type Transporter } from "nodemailer";
import { MailService } from "@sendgrid/mail";

interface MailerProvider {
  send(to: string, subject: string, html: string): Promise<void>;
}

class SmtpMailerProvider implements MailerProvider {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    const { host, port, user, pass } = config.get("smtp");
    return new SmtpMailerProvider(
      nodemailer.createTransport({ host, port, auth: { user, pass } }),
    );
  }
  constructor(private transport: Transporter) {}
  async send(to: string, subject: string, html: string) {
    await this.transport.sendMail({ to, subject, html });
  }
}

class SendGridMailerProvider implements MailerProvider {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    const sg = new MailService();
    sg.setApiKey(config.get("sendgrid.apiKey"));
    return new SendGridMailerProvider(sg, config.get("sendgrid.from"));
  }
  constructor(private sg: MailService, private from: string) {}
  async send(to: string, subject: string, html: string) {
    await this.sg.send({ to, from: this.from, subject, html });
  }
}

class Mailer {
  static async createInstance() {
    const config = await di.resolve(AppConfig);
    switch (config.get("mailer.provider")) {
      case "smtp":     return new Mailer(await di.resolve(SmtpMailerProvider));
      case "sendgrid": return new Mailer(await di.resolve(SendGridMailerProvider));
      default: throw new Error("Unknown mailer provider");
    }
  }
  constructor(private provider: MailerProvider) {}
  send(to: string, subject: string, html: string) {
    return this.provider.send(to, subject, html);
  }
}

const mailer = await di.resolve(Mailer); // SMTP or SendGrid based on config
```

#### Using a factory

Same `Mailer`, different wiring — pull the dispatch out into a dedicated factory:

```ts
class MailerProviderFactory {
  static async createInstance() {
    return new MailerProviderFactory(await di.resolve(AppConfig));
  }
  constructor(private config: AppConfig) {}
  create(): Promise<MailerProvider> {
    switch (this.config.get("mailer.provider")) {
      case "smtp":     return di.resolve(SmtpMailerProvider);
      case "sendgrid": return di.resolve(SendGridMailerProvider);
      default: throw new Error("Unknown mailer provider");
    }
  }
}

class Mailer {
  static async createInstance() {
    const factory = await di.resolve(MailerProviderFactory);
    return new Mailer(await factory.create());
  }
  constructor(private provider: MailerProvider) {}
  send(to: string, subject: string, html: string) {
    return this.provider.send(to, subject, html);
  }
}
```

### Scopes

| Scope | Behavior |
|-------|----------|
| `singleton` | Cached forever in container. Default. |
| `transient` | New instance every `resolve()`. Cannot be `seed()`-ed. |
| `scoped` | Cached per `run()`. Requires active scope. |

Declare a scope explicitly only when you need to override the inferred default.

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

#### Scope inheritance and validation

A token's effective scope is the narrowest scope of its dependencies when `injectionScope` is omitted, and an explicit `injectionScope` that is wider than its narrowest dependency throws at resolve time. Both `Snabditel` and `AlsSnabditel` apply this rule.

Lifetime ordering, narrowest to widest: `transient` → `scoped` → `singleton`.

```ts
import { AlsSnabditel } from "snabditel/als";

const di = new AlsSnabditel();

class RequestId {
  static readonly injectionScope = "scoped";
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
  static readonly injectionScope = "singleton";
  static async createInstance() {
    await di.resolve(RequestId);    // throws: declared singleton, dep is scoped
    return new BadCache();
  }
}
```

Inference and validation are first-resolve operations. Once a token is cached, subsequent resolves do not re-evaluate. Both `Snabditel` and `AlsSnabditel` share this engine.

#### Concurrent scopes

Both flavors handle parallel `run()` calls. Base `Snabditel` requires the explicit `s` resolver passed to `run`'s callback (and to `createInstance`); `AlsSnabditel` propagates it implicitly via `AsyncLocalStorage`.

(`Logger`, `req1`, and `req2` elided — see Quick start for `Logger`.)

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
- **Singletons:** disposed only on explicit `container.dispose()`, LIFO. Call at shutdown:

  ```ts
  await di.dispose();
  ```

- **Transient** instances are never cached, never auto-disposed. Use `await using x = await s.resolve(X)` to dispose them at block exit.
- **Seeded values** are not disposed — the caller owns the lifetime.

If a disposer throws, the others still run. Multiple failures surface as `AggregateError`. If the `run()` body also threw, the body error is `errors[0]`.

Don't allocate new resources via `resolve()` from inside a disposer — disposers run after the cache is drained, so new instances would be tracked but require another `dispose()` to clean.

### Seeding

Pre-populate values by class, string, or symbol token. Useful for test doubles and per-request data.

```ts
// Override a class with a fake — great for tests
const fakeLogger: Logger = { info: () => {} } as Logger;
di.seed(Logger, fakeLogger);

// Per-run scoped data (e.g. current user)
class CurrentUser { constructor(public id: string) {} }

await di.run(async (s) => {
  // scoped seed: shadows any singleton seed for this run() only
  s.seed(CurrentUser, new CurrentUser("u_123"), { injectionScope: "scoped" });
  const user = await s.resolve(CurrentUser);
});
```

A `transient` seed throws.

## Testing

The point of DI is that your class doesn't reach for its dependencies. In tests, skip the container entirely and pass a fake straight to the constructor — no `seed()`, no `run()`, no async wiring.

```ts
import { test, expect } from "bun:test";

class FakeMailerProvider implements MailerProvider {
  sent: Array<{ to: string; subject: string }> = [];
  async send(to: string, subject: string) {
    this.sent.push({ to, subject });
  }
}

test("sends welcome email", async () => {
  const fake = new FakeMailerProvider();
  const mailer = new Mailer(fake);

  await mailer.send("ada@example.com", "Welcome", "<p>hi</p>");

  expect(fake.sent).toEqual([{ to: "ada@example.com", subject: "Welcome" }]);
});
```

When you _do_ need DI in a test — to exercise the wiring, or to override a deeply-nested dep — use `seed()` (see [Seeding](#seeding)).

## API

```ts
type InjectionScope = "singleton" | "transient" | "scoped";

type Token<T> =
  | (new () => T)
  | (SelfResolvable<T>)   // class with static createInstance + optional injectionScope
  | string
  | symbol;

interface ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(
    token: string | symbol | (new (...a: any[]) => T),
    value: T,
    options?: { injectionScope?: InjectionScope },
  ): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
}

class Snabditel implements ASnabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(
    token: string | symbol | (new (...a: any[]) => T),
    value: T,
    options?: { injectionScope?: InjectionScope },
  ): void;
  run<T>(cb: (s: ASnabditel) => Promise<T>): Promise<T>;
  dispose(): Promise<void>; // disposes singleton instances LIFO
}
class AlsSnabditel implements ASnabditel { /* same surface, incl. dispose(); AsyncLocalStorage-backed run() — s arg optional in practice */ }
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
