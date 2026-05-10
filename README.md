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
