import { describe, expect, test } from "bun:test";
import express, { type Express, type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AlsSnabditel } from "./als";
import { expressScope } from "./express";

type AppFixture = {
  app: Express;
  server: Server;
  base: string;
  di: AlsSnabditel;
};

async function startApp(
  build: (di: AlsSnabditel, app: Express) => void,
): Promise<AppFixture> {
  const di = new AlsSnabditel();
  const app = express();
  app.use(expressScope(di));
  build(di, app);
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { app, server, di, base: `http://127.0.0.1:${port}` };
}

async function stopApp(fx: AppFixture): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fx.server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("expressScope (real Express)", () => {
  test("handler resolves scoped instance through ALS", async () => {
    class Tag {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new Tag(); }
      id = Math.random();
    }
    const fx = await startApp((di, app) => {
      app.get("/tag", (async (_req, res) => {
        const t1 = await di.resolve(Tag);
        const t2 = await di.resolve(Tag);
        res.json({ same: t1 === t2, id: t1.id });
      }) as RequestHandler);
    });
    try {
      const r = await fetch(`${fx.base}/tag`);
      const body = (await r.json()) as { same: boolean; id: number };
      expect(body.same).toBe(true);
      expect(typeof body.id).toBe("number");
    } finally {
      await stopApp(fx);
    }
  });

  test("each request gets a fresh scope (no cross-request leak)", async () => {
    class Tag {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new Tag(); }
      id = Math.random();
    }
    const fx = await startApp((di, app) => {
      app.get("/tag", (async (_req, res) => {
        const t = await di.resolve(Tag);
        res.json({ id: t.id });
      }) as RequestHandler);
    });
    try {
      const a = (await (await fetch(`${fx.base}/tag`)).json()) as { id: number };
      const b = (await (await fetch(`${fx.base}/tag`)).json()) as { id: number };
      expect(a.id).not.toBe(b.id);
    } finally {
      await stopApp(fx);
    }
  });

  test("scoped resource is disposed after response completes", async () => {
    const disposed: string[] = [];
    class Db {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new Db(); }
      async [Symbol.asyncDispose]() { disposed.push("db"); }
    }
    const fx = await startApp((di, app) => {
      app.get("/", (async (_req, res) => {
        await di.resolve(Db);
        res.json({ ok: true });
      }) as RequestHandler);
    });
    try {
      await fetch(`${fx.base}/`);
      // Disposal happens after the response is sent — give the close event a tick.
      for (let i = 0; i < 20 && disposed.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      expect(disposed).toEqual(["db"]);
    } finally {
      await stopApp(fx);
    }
  });

  test("disposes even when handler short-circuits with res.end() before next tick", async () => {
    // Reproduces the listener-ordering bug: if res.once("close") were attached
    // after next(), a sync-ending handler could emit "close" before the listener
    // is wired, and the run() promise would never resolve.
    const disposed: string[] = [];
    class Db {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new Db(); }
      async [Symbol.asyncDispose]() { disposed.push("db"); }
    }
    const fx = await startApp((di, app) => {
      app.get("/quick", (async (_req, res) => {
        await di.resolve(Db);
        res.status(204).end();
      }) as RequestHandler);
    });
    try {
      const r = await fetch(`${fx.base}/quick`);
      expect(r.status).toBe(204);
      for (let i = 0; i < 20 && disposed.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      expect(disposed).toEqual(["db"]);
    } finally {
      await stopApp(fx);
    }
  });

  test("routes disposer errors to req.log.error", async () => {
    const logged: unknown[] = [];
    class BadDb {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new BadDb(); }
      async [Symbol.asyncDispose]() { throw new Error("dispose-fail"); }
    }
    const fx = await startApp((di, app) => {
      // Inject a req.log per request before expressScope's catch fires.
      app.use((req, _res, next) => {
        (req as unknown as { log: { error: (e: unknown) => void } }).log = {
          error: (e) => { logged.push(e); },
        };
        next();
      });
      app.get("/", (async (_req, res) => {
        await di.resolve(BadDb);
        res.json({ ok: true });
      }) as RequestHandler);
    });
    try {
      await fetch(`${fx.base}/`);
      for (let i = 0; i < 20 && logged.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      expect(logged.length).toBe(1);
      const err = logged[0];
      expect(err).toBeInstanceOf(AggregateError);
      const inner = (err as AggregateError).errors[0] as Error;
      expect(inner.message).toBe("dispose-fail");
    } finally {
      await stopApp(fx);
    }
  });

});
