# snabditel

Tiny async zero deps DI container.

Snabditel (снабдител) means "supplier" in Bulgarian — it supplies your services with their dependencies and it supplies you with your services.

Snabditel is not only a library but also an idea: that DI can be simple, flexible, and safe without magic or ceremony.

Resolves classes, factories, and tokens. Three scopes: `singleton`, `transient`, `scoped`. Two flavors:

- `Snabditel` — single-flight `run()` scope (no concurrent scopes).
- `AlsSnabditel` — `AsyncLocalStorage`-backed scope, safe under parallel `run()` calls.

## Install

```bash
npm install snabditel
pnpm add snabditel
yarn add snabditel
bun add snabditel
```

## Quick start

Container wires deps for you — no manual `new Foo(new Bar(...))` chains.

```ts
import { Snabditel } from "snabditel";

const di = new Snabditel();

class Logger {
  info(msg: string) { console.log(msg); }
}

class UserService {
  static readonly injectionScope = "scoped";
  static async createInstance() {
    const logger = await di.resolve(Logger);
    return new UserService(logger);
  }

  constructor(private logger: Logger) {}

  greet(name: string) { this.logger.info(`hello ${name}`); }
}

await di.run(async () => {
  const users = await di.resolve(UserService);
  users.greet("ada");
});
```

`UserService` declares its own deps via `createInstance` — DI resolves `Logger` for it. Scope is `scoped` so each `run()` (e.g. each request) gets a fresh `UserService` while `Logger` stays singleton.

## Tokens

Anything resolvable:

- **Plain class** — `new ()` constructor with no deps. Default scope: singleton.
- **Class with static `createInstance` (and optional `injectionScope`)** — class itself acts as a `SelfResolvable`. Use when class has deps or async setup.
- **String / symbol** — must be `seed()`-ed first. Use sparingly (config, request context).

### Class with async init

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

### Swapping an implementation

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

### Using factory

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

### Non-class values (when you need them)

Strings/symbols work for plain config or request data — DI still tracks lifetime:

```ts
di.seed("CFG", { apiUrl: "https://api.example.com" });
const cfg = await di.resolve<{ apiUrl: string }>("CFG");
```

## Scopes

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

### Scope inheritance and validation (`AlsSnabditel`)

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

## Seeding

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

Scoped seeds shadow singleton seeds inside `run()`. `transient` seed throws.

## Concurrent scopes (`AlsSnabditel`)

Base `Snabditel` has single-flight `run()` — nested or concurrent `run()` throws. For parallel requests use ALS variant:

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

Subpath exists so `node:async_hooks` only loads when imported.

## API

```ts
class Snabditel {
  resolve<T>(token: Token<T>): Promise<T>;
  seed<T>(token: string | symbol | (new (...a: any[]) => T), value: T, options?: { injectionScope?: InjectionScope }): void;
  run<T>(cb: () => Promise<T>): Promise<T>;
}

class AlsSnabditel extends Snabditel {} // ALS-backed run()
```

## Develop

```bash
bun install
bun test
bun run typecheck
bun run build
```

Source written for Bun, but the published package targets Node and runs anywhere ESM/CJS does.
