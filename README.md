# snabditel

Tiny TypeScript dependency injection. One class, three methods, three lifetimes. Works in Node and the browser. Zero runtime dependencies.

```ts
import { Snabditel } from 'snabditel';
```

## The whole API

```ts
class Snabditel {
  constructor(parent?: Snabditel);

  seed<R extends Resolvable>(key: R, instance: Resolved<R>): this;
  seed<T>(token: string, instance: T): this;

  resolve<R extends Resolvable>(key: R): Promise<Resolved<R>>;
  resolve<T = unknown>(token: string): Promise<T>;

  run<T>(fn: (scope: Snabditel) => Promise<T> | T): Promise<T>;
}

type InjectionScope = 'singleton' | 'scoped' | 'transient';

type Resolvable<T = unknown> = {
  getInstance(snabditel: Snabditel): Promise<T> | T;
  injectionScope?: InjectionScope;
};
```

A class becomes resolvable by exposing `static getInstance(s: Snabditel)`. The resolved type is `Awaited<ReturnType<typeof Class.getInstance>>` — no decorators, no reflection.

## Basics

```ts
class Greeter {
  static async getInstance() {
    return { hello: (name: string) => `hi, ${name}` };
  }
}

const root = new Snabditel();
const greeter = await root.resolve(Greeter);
greeter.hello('world');
```

## Nested deps

`getInstance` receives the current scope, so dependencies just call `resolve` themselves:

```ts
class Db {
  static async getInstance() { return await connect(); }
}

class UserRepo {
  constructor(private db: Awaited<ReturnType<typeof Db.getInstance>>) {}
  static async getInstance(s: Snabditel) {
    return new UserRepo(await s.resolve(Db));
  }
}
```

## Lifetimes

Set the optional `static injectionScope` to control where the instance lives.

| `injectionScope`        | Behavior                                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| `'singleton'`           | One instance, cached at the **root** scope. Reused everywhere.          |
| `'scoped'` *(default)*  | One instance per scope. Child scopes inherit a parent's cached value.   |
| `'transient'`           | A fresh instance on every `resolve`. No caching, no concurrent dedupe.  |

```ts
class Db          { static injectionScope = 'singleton' as const; static async getInstance() { /* ... */ } }
class RequestSvc  { /* default: scoped */                          static async getInstance(s: Snabditel) { /* ... */ } }
class RequestId   { static injectionScope = 'transient' as const; static async getInstance() { return crypto.randomUUID(); } }
```

`seed` always wins over auto-construction in the scope it was placed in — useful for tests and for injecting platform values like a request object.

## String tokens for platform values

Strings can be seeded and resolved like any other key, but they are never auto-constructed (`resolve('missing')` throws). Wrap them in a typed class to give the rest of your code a strongly typed handle:

```ts
import type { IncomingMessage } from 'node:http';

class AppRequest {
  static async getInstance(s: Snabditel) {
    return s.resolve<IncomingMessage>('request');
  }
}
```

## Scopes

`run(fn)` opens a child scope. The child sees everything cached or seeded along its parent chain; anything seeded inside it stays inside it. When the callback's promise settles the child is dropped — no `AsyncLocalStorage`, no global state, so the same code runs unchanged in the browser.

### Node — per-request scope

```ts
import http from 'node:http';
import { Snabditel } from 'snabditel';

class Db {
  static injectionScope = 'singleton' as const;
  static async getInstance() { return await connectToPostgres(process.env.DATABASE_URL!); }
}

class AppRequest {
  static async getInstance(s: Snabditel) {
    return s.resolve<http.IncomingMessage>('request');
  }
}

class UserService {
  constructor(
    private db: Awaited<ReturnType<typeof Db.getInstance>>,
    private req: http.IncomingMessage,
  ) {}
  static async getInstance(s: Snabditel) {
    return new UserService(await s.resolve(Db), await s.resolve(AppRequest));
  }
  whoAmI() { return this.req.headers['x-user'] ?? 'anon'; }
}

const root = new Snabditel();

http.createServer((req, res) => {
  root.run(async (scope) => {
    scope.seed('request', req);
    const users = await scope.resolve(UserService);
    res.end(JSON.stringify({ user: users.whoAmI() }));
  });
}).listen(3000);
```

### Browser — React provider at the app root

```tsx
import { createContext, useContext, useMemo, useEffect, useState, type ReactNode } from 'react';
import { Snabditel } from 'snabditel';

const SnabditelContext = createContext<Snabditel | null>(null);

export function SnabditelProvider({ children }: { children: ReactNode }) {
  const root = useMemo(() => new Snabditel(), []);
  return <SnabditelContext.Provider value={root}>{children}</SnabditelContext.Provider>;
}

export function useSnabditel() {
  const s = useContext(SnabditelContext);
  if (!s) throw new Error('SnabditelProvider missing');
  return s;
}

export class ApiClient {
  static injectionScope = 'singleton' as const;
  static async getInstance() {
    return { get: (url: string) => fetch(url).then((r) => r.json()) };
  }
}

export class TodoService {
  constructor(private api: Awaited<ReturnType<typeof ApiClient.getInstance>>) {}
  static async getInstance(s: Snabditel) {
    return new TodoService(await s.resolve(ApiClient));
  }
  list() { return this.api.get('/api/todos'); }
}

function TodoList() {
  const root = useSnabditel();
  const [todos, setTodos] = useState<unknown[]>([]);
  useEffect(() => {
    let cancelled = false;
    root.run(async (scope) => {
      const svc = await scope.resolve(TodoService);
      const result = await svc.list();
      if (!cancelled) setTodos(result);
    });
    return () => { cancelled = true; };
  }, [root]);
  return <ul>{todos.map((t: any) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

## Notes

- Concurrent resolves of the same `'scoped'` or `'singleton'` class share the in-flight promise (no double construction). `'transient'` skips this on purpose.
- A throwing `getInstance` does not poison the cache; the next `resolve` retries.
- `seed` always writes to the current scope and only the current scope. Children see it via the parent chain; siblings don't.
