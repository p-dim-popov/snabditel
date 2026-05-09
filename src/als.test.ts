import { describe, expect, test } from "bun:test";
import { AlsSnabditel } from "./als";
import type { SelfResolvable } from "./snabditel.types";

describe("AlsSnabditel", () => {
  test("scoped instance persists across awaits inside run", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    await s.run(async () => {
      const a = await s.resolve(r);
      await new Promise((res) => setTimeout(res, 5));
      const b = await s.resolve(r);
      expect(a).toBe(b);
    });
  });

  test("parallel runs are isolated", async () => {
    const r: SelfResolvable<{ id: number }> = {
      createInstance: () => ({ id: Math.random() }),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();

    const captured: { id: number }[] = [];
    const work = (delayMs: number) =>
      s.run(async () => {
        const a = await s.resolve(r);
        await new Promise((res) => setTimeout(res, delayMs));
        const b = await s.resolve(r);
        expect(a).toBe(b);
        captured.push(a);
        return a;
      });

    const [r1, r2] = await Promise.all([work(20), work(5)]);
    expect(r1).not.toBe(r2);
    expect(captured.length).toBe(2);
  });

  test("scoped resolve outside run still throws", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    await expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
  });

  test("singleton works as in base class", async () => {
    class Foo {}
    const s = new AlsSnabditel();
    const a = await s.resolve(Foo);
    const b = await s.resolve(Foo);
    expect(a).toBe(b);
  });

  test("parallel runs resolving scoped do not false-positive cycle", async () => {
    const r: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        await new Promise((res) => setTimeout(res, 10));
        return { id: Math.random() };
      },
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    await Promise.all([
      s.run(async () => { await s.resolve(r); }),
      s.run(async () => { await s.resolve(r); }),
    ]);
  });

  test("cycle still detected within single resolve chain", async () => {
    const s = new AlsSnabditel();
    const a: SelfResolvable<object> = {
      createInstance: async () => {
        await s.resolve(b);
        return {};
      },
    };
    const b: SelfResolvable<object> = {
      createInstance: async () => {
        await s.resolve(a);
        return {};
      },
    };
    await expect(s.resolve(a)).rejects.toThrow(/Cycle detected/);
  });

  test("nested run gets fresh scope", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    let outer: object | null = null;
    let inner: object | null = null;
    await s.run(async () => {
      outer = await s.resolve(r);
      await s.run(async () => {
        inner = await s.resolve(r);
      });
    });
    expect(outer!).not.toBe(inner!);
  });

  test("concurrent runs resolving same singleton: single-flight, one createInstance", async () => {
    let calls = 0;
    const r: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        calls++;
        await new Promise((res) => setTimeout(res, 10));
        return { id: calls };
      },
    };
    const s = new AlsSnabditel();
    const [a, b] = await Promise.all([
      s.run(async () => s.resolve(r)),
      s.run(async () => s.resolve(r)),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("concurrent resolve of same scoped within one run: single-flight", async () => {
    let calls = 0;
    const r: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        calls++;
        await new Promise((res) => setTimeout(res, 10));
        return { id: calls };
      },
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    await s.run(async () => {
      const [a, b, c] = await Promise.all([
        s.resolve(r),
        s.resolve(r),
        s.resolve(r),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
    expect(calls).toBe(1);
  });
});

test("resolve string token returns seeded singleton (skeleton wiring)", async () => {
  const s = new AlsSnabditel();
  s.seed("K", 42);
  expect(await s.resolve<number>("K")).toBe(42);
});

test("resolve symbol token returns seeded singleton", async () => {
  const s = new AlsSnabditel();
  const T = Symbol("t");
  s.seed(T, 5);
  expect(await s.resolve<number>(T)).toBe(5);
});

test("scoped seed shadows singleton seed within run", async () => {
  const s = new AlsSnabditel();
  s.seed("K", "global");
  await s.run(async () => {
    s.seed("K", "request", { injectionScope: "scoped" });
    expect(await s.resolve<string>("K")).toBe("request");
  });
  expect(await s.resolve<string>("K")).toBe("global");
});

test("unknown string token throws", async () => {
  const s = new AlsSnabditel();
  await expect(s.resolve("MISSING")).rejects.toThrow(/Unknown token/);
});
