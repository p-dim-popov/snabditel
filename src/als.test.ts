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
    expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
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
    expect(s.resolve(a)).rejects.toThrow(/Cycle detected/);
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
});
