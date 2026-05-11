import { describe, expect, test } from "bun:test";
import { AlsSnabditel } from "./als";
import type { SelfResolvable } from "./snabditel.types";

describe("AlsSnabditel — implicit propagation", () => {
  test("createInstance can use module-level di.resolve without s arg", async () => {
    const di = new AlsSnabditel();
    class Logger {}
    class Service {
      // Note: no s arg — relies on ALS implicit propagation.
      static async createInstance() {
        return new Service(await di.resolve(Logger));
      }
      constructor(public logger: Logger) {}
    }
    await di.run(async () => {
      const a = await di.resolve(Service);
      expect(a).toBeInstanceOf(Service);
      expect(a.logger).toBeInstanceOf(Logger);
    });
  });

  test("parallel runs isolated without explicit s threading", async () => {
    const di = new AlsSnabditel();
    const r: SelfResolvable<{ id: number }> = {
      createInstance: () => ({ id: Math.random() }),
      injectionScope: "scoped",
    };
    const work = (delay: number) =>
      di.run(async () => {
        const a = await di.resolve(r);
        await new Promise((res) => setTimeout(res, delay));
        const b = await di.resolve(r);
        expect(a).toBe(b);
        return a;
      });
    const [r1, r2] = await Promise.all([work(20), work(5)]);
    expect(r1).not.toBe(r2);
  });

  test("scoped seed via di.seed reads ALS-current scope", async () => {
    const di = new AlsSnabditel();
    const inside1 = await di.run(async () => {
      di.seed("REQ", 1, { injectionScope: "scoped" });
      return di.resolve<number>("REQ");
    });
    const inside2 = await di.run(async () => {
      di.seed("REQ", 2, { injectionScope: "scoped" });
      return di.resolve<number>("REQ");
    });
    expect(inside1).toBe(1);
    expect(inside2).toBe(2);
    await expect(di.resolve("REQ")).rejects.toThrow(/Unknown token/);
  });

  test("scoped seed outside run() throws", async () => {
    const di = new AlsSnabditel();
    expect(() =>
      di.seed<number>("REQ", 1, { injectionScope: "scoped" }),
    ).toThrow(/Scoped seed requires an active run\(\) scope/);
  });

  test("cycle detection works without s arg threading", async () => {
    const di = new AlsSnabditel();
    class A {
      static async createInstance() {
        await di.resolve(B);
        return new A();
      }
    }
    class B {
      static async createInstance() {
        await di.resolve(A);
        return new B();
      }
    }
    // Cast to satisfy TS80007 (expectation on a rejected promise, similar to snabditel.test.ts)
    await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
  });
});

describe("AlsSnabditel — disposal", () => {
  test("disposes scoped instances at run() end", async () => {
    let disposed = false;
    class Db {
      static readonly injectionScope = "scoped" as const;
      static async createInstance() { return new Db(); }
      async [Symbol.asyncDispose]() { disposed = true; }
    }
    const s = new AlsSnabditel();
    await s.run(async () => { await s.resolve(Db); });
    expect(disposed).toBe(true);
  });

  test("container.dispose() disposes singletons", async () => {
    let disposed = false;
    class App {
      static createInstance() { return new App(); }
      async [Symbol.asyncDispose]() { disposed = true; }
    }
    const s = new AlsSnabditel();
    await s.resolve(App);
    await s.dispose();
    expect(disposed).toBe(true);
  });
});
