import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AlsSnabditel } from "./als";
import { expressScope } from "./express";

class FakeRes extends EventEmitter {
  override once(event: "close", cb: () => void): this {
    return super.once(event, cb);
  }
}

describe("expressScope", () => {
  test("calls next() inside ALS scope", async () => {
    const di = new AlsSnabditel();
    class Tag {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new Tag(); }
      id = Math.random();
    }
    const res = new FakeRes();
    let resolvedInsideNext: Tag | null = null;
    const mw = expressScope(di);

    const handler = async () => {
      resolvedInsideNext = await di.resolve(Tag);
    };

    const done = new Promise<void>((r) => res.once("close", r));
    mw(
      {},
      res as unknown as { once: (event: "close", cb: () => void) => void },
      () => { void handler(); },
    );

    await new Promise((r) => setImmediate(r));
    res.emit("close");
    await done;

    expect(resolvedInsideNext).toBeInstanceOf(Tag);
  });

  test("holds scope until res emits close, then disposes", async () => {
    let disposed = false;
    class Db {
      static readonly injectionScope = "scoped" as const;
      static async createInstance() { return new Db(); }
      async [Symbol.asyncDispose]() { disposed = true; }
    }
    const di = new AlsSnabditel();
    const res = new FakeRes();
    const mw = expressScope(di);

    mw(
      {},
      res as unknown as { once: (event: "close", cb: () => void) => void },
      async () => { await di.resolve(Db); },
    );

    await new Promise((r) => setImmediate(r));
    expect(disposed).toBe(false);
    res.emit("close");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(disposed).toBe(true);
  });

  test("routes scope errors to req.log.error when present", async () => {
    const di = new AlsSnabditel();
    const res = new FakeRes();
    const logged: unknown[] = [];
    const req = { log: { error: (e: unknown) => { logged.push(e); } } };
    const mw = expressScope(di);

    mw(
      req,
      res as unknown as { once: (event: "close", cb: () => void) => void },
      () => { throw new Error("boom"); },
    );

    await new Promise((r) => setImmediate(r));
    res.emit("close");
    await new Promise((r) => setImmediate(r));
    expect(logged.length).toBe(1);
    expect((logged[0] as Error).message).toBe("boom");
  });
});
