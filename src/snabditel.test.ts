import { describe, expect, test } from "bun:test";
import { Snabditel } from "./snabditel";
import type { ASnabditel, SelfResolvable } from "./snabditel.types";

describe("Snabditel", () => {
  test("resolve(Class) instantiates and caches as singleton by default", async () => {
    class Foo {}
    const s = new Snabditel();
    const a = await s.resolve(Foo);
    const b = await s.resolve(Foo);
    expect(a).toBeInstanceOf(Foo);
    expect(a).toBe(b);
  });

  test("seed pre-populates string token", async () => {
    const s = new Snabditel();
    s.seed("CFG", { url: "x" });
    const got = await s.resolve<{ url: string }>("CFG");
    expect(got.url).toBe("x");
  });

  test("seed with scoped option lives in current run scope", async () => {
    const s = new Snabditel();
    const req1 = { id: 1 };
    const req2 = { id: 2 };
    let inside1: typeof req1 | null = null;
    let inside2: typeof req2 | null = null;
    await s.run(async (sc) => {
      sc.seed("REQ", req1, { injectionScope: "scoped" });
      inside1 = await sc.resolve<typeof req1>("REQ");
    });
    await s.run(async (sc) => {
      sc.seed("REQ", req2, { injectionScope: "scoped" });
      inside2 = await sc.resolve<typeof req2>("REQ");
    });
    expect(inside1!.id).toBe(1);
    expect(inside2!.id).toBe(2);
    await expect(s.resolve("REQ")).rejects.toThrow(/Unknown token/);
  });

  test("scoped seed outside run throws", () => {
    const s = new Snabditel();
    expect(() => s.seed("REQ", {}, { injectionScope: "scoped" })).toThrow(
      /run\(\) scope/,
    );
  });

  test("transient seed throws", () => {
    const s = new Snabditel();
    expect(() => s.seed("X", {}, { injectionScope: "transient" })).toThrow(
      /transient/,
    );
  });

  test("scoped seed shadows singleton seed in run", async () => {
    const s = new Snabditel();
    s.seed("LOG", "global");
    let inside: string | null = null;
    let outside: string;
    await s.run(async (sc) => {
      sc.seed("LOG", "request", { injectionScope: "scoped" });
      inside = await sc.resolve<string>("LOG");
    });
    outside = await s.resolve<string>("LOG");
    expect(inside!).toBe("request");
    expect(outside).toBe("global");
  });

  test("seed pre-populates symbol token", async () => {
    const s = new Snabditel();
    const TOK = Symbol("tok");
    s.seed(TOK, 42);
    expect(await s.resolve<number>(TOK)).toBe(42);
  });

  test("seed pre-populates class token (overrides ctor)", async () => {
    class Foo { hi() { return "real"; } }
    const fake = { hi: () => "fake" } as unknown as Foo;
    const s = new Snabditel();
    s.seed(Foo, fake);
    const got = await s.resolve(Foo);
    expect(got.hi()).toBe("fake");
  });

  test("unknown string token throws", async () => {
    const s = new Snabditel();
    await expect(s.resolve("MISSING")).rejects.toThrow(/Unknown token/);
  });

  test("SelfResolvable.createInstance is awaited", async () => {
    const r: SelfResolvable<{ n: number }> = {
      createInstance: async () => ({ n: 7 }),
    };
    const s = new Snabditel();
    const got = await s.resolve(r);
    expect(got.n).toBe(7);
  });

  test("transient scope returns new instance each time", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new Snabditel();
    const a = await s.resolve(r);
    const b = await s.resolve(r);
    expect(a).not.toBe(b);
  });

  test("scoped: same instance within run, different across runs", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new Snabditel();
    let inner1a: object | null = null;
    let inner1b: object | null = null;
    await s.run(async (sc) => {
      inner1a = await sc.resolve(r);
      inner1b = await sc.resolve(r);
    });
    let inner2: object | null = null;
    await s.run(async (sc) => {
      inner2 = await sc.resolve(r);
    });
    expect(inner1a!).toBe(inner1b!);
    expect(inner1a!).not.toBe(inner2!);
  });

  test("scoped resolve outside run throws", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new Snabditel();
    await expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
  });

  test("sequential run() works after prior completes", async () => {
    const s = new Snabditel();
    await s.run(async () => {});
    await s.run(async () => {});
  });

  test("concurrent resolve of same singleton: single-flight, one createInstance, same instance", async () => {
    let calls = 0;
    const r: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        calls++;
        await new Promise((res) => setTimeout(res, 10));
        return { id: calls };
      },
    };
    const s = new Snabditel();
    const [a, b, c] = await Promise.all([
      s.resolve(r),
      s.resolve(r),
      s.resolve(r),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toBe(1);
  });

  test("concurrent resolves with overlapping shared dep do not false-positive cycle", async () => {
    const di = new Snabditel();
    const Shared: SelfResolvable<{ shared: true }> = {
      createInstance: async () => {
        await new Promise((res) => setTimeout(res, 10));
        return { shared: true };
      },
    };
    const A: SelfResolvable<{ a: true }> = {
      createInstance: async (s) => {
        await s.resolve(Shared);
        return { a: true };
      },
    };
    const B: SelfResolvable<{ b: true }> = {
      createInstance: async (s) => {
        await s.resolve(Shared);
        return { b: true };
      },
    };
    await Promise.all([di.resolve(A), di.resolve(B)]);
  });

  test("singleton retries after createInstance failure (cache evicted on reject)", async () => {
    let calls = 0;
    const r: SelfResolvable<{ ok: boolean }> = {
      createInstance: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { ok: true };
      },
    };
    const s = new Snabditel();
    await expect(s.resolve(r)).rejects.toThrow(/boom/);
    const got = await s.resolve(r);
    expect(got.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("parallel runs are isolated (browser-safe, no ALS)", async () => {
    class RequestId {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new RequestId(); }
      id = Math.random();
    }
    const di = new Snabditel();

    const work = (delay: number) =>
      di.run(async (s) => {
        const a = await s.resolve(RequestId);
        await new Promise((r) => setTimeout(r, delay));
        const b = await s.resolve(RequestId);
        expect(a).toBe(b);
        return a;
      });

    const [r1, r2] = await Promise.all([work(20), work(5)]);
    expect(r1).not.toBe(r2);
  });

  test("scope inheritance: undeclared inherits narrowest dep scope", async () => {
    class RequestId {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new RequestId(); }
      id = Math.random();
    }
    class UserService {
      static async createInstance(s: ASnabditel) {
        return new UserService(await s.resolve(RequestId));
      }
      constructor(public req: RequestId) {}
    }
    const di = new Snabditel();
    const a = await di.run(async (s) => {
      const u = await s.resolve(UserService);
      return u.req;
    });
    const b = await di.run(async (s) => {
      const u = await s.resolve(UserService);
      return u.req;
    });
    expect(a).not.toBe(b);
  });

  test("validation: declared singleton with scoped dep throws", async () => {
    class RequestId {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new RequestId(); }
    }
    class BadCache {
      static readonly injectionScope = "singleton" as const;
      static async createInstance(s: ASnabditel) {
        await s.resolve(RequestId);
        return new BadCache();
      }
    }
    const di = new Snabditel();
    await expect(
      di.run((s) => s.resolve(BadCache)),
    ).rejects.toThrow(/depends on a scoped service/);
  });

  test("cycle detection via parent frame chain", async () => {
    class A {
      static async createInstance(s: ASnabditel) {
        await s.resolve(B);
        return new A();
      }
    }
    class B {
      static async createInstance(s: ASnabditel) {
        await s.resolve(A);
        return new B();
      }
    }
    const di = new Snabditel();
    // Cast: class-recursive createInstance types confuse TS-LS into typing
    // expect(p).rejects.toThrow(...) as void; tsgo is fine. Cast is safe.
    await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
  });

  test("cross-run singleton race: same instance, single createInstance call", async () => {
    let constructed = 0;
    class Slow {
      static async createInstance() {
        constructed++;
        await new Promise((r) => setTimeout(r, 10));
        return new Slow();
      }
    }
    const di = new Snabditel();
    const [a, b] = await Promise.all([
      di.run((s) => s.resolve(Slow)),
      di.run((s) => s.resolve(Slow)),
    ]);
    expect(a).toBe(b);
    expect(constructed).toBe(1);
  });

  test("transient scope rebuilt per resolve, scoped deps shared in same run", async () => {
    let apiBuilds = 0;
    class AuthToken {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new AuthToken(); }
      value = Math.random();
    }
    class Api {
      static readonly injectionScope = "transient" as const;
      static async createInstance(s: ASnabditel) {
        apiBuilds++;
        return new Api(await s.resolve(AuthToken));
      }
      constructor(public auth: AuthToken) {}
    }
    const di = new Snabditel();
    await di.run(async (s) => {
      const a1 = await s.resolve(Api);
      const a2 = await s.resolve(Api);
      expect(a1).not.toBe(a2);
      expect(a1.auth).toBe(a2.auth);
    });
    expect(apiBuilds).toBe(2);
  });

  test("nested run: scope reset, frame inherited (cycle survives)", async () => {
    class A {
      static async createInstance(s: ASnabditel) {
        // Schedule an inner run that re-asks for A — should detect cycle.
        return s.run(async (s2) => {
          await s2.resolve(A);
          return new A();
        });
      }
    }
    const di = new Snabditel();
    // Cast: class-recursive createInstance types confuse TS-LS into typing
    // expect(p).rejects.toThrow(...) as void; tsgo is fine. Cast is safe.
    await (expect(di.resolve(A)).rejects.toThrow(/Cycle detected/) as unknown as Promise<void>);
  });

  test("captured s after run() end keeps using the captured scope map", async () => {
    class RequestId {
      static readonly injectionScope = "scoped" as const;
      static createInstance() { return new RequestId(); }
      id = Math.random();
    }
    const di = new Snabditel();
    let captured!: ASnabditel;
    const inside = await di.run(async (s) => {
      captured = s;
      return s.resolve(RequestId);
    });
    const after = await captured.resolve(RequestId);
    expect(after).toBe(inside);
  });

  test("source does not import node:async_hooks", async () => {
    const source = await Bun.file(`${import.meta.dir}/snabditel.ts`).text();
    expect(source).not.toMatch(/async_hooks/);
  });
});

describe("Snabditel disposal helpers", () => {
  test("disposeAll calls Symbol.asyncDispose LIFO", async () => {
    const calls: string[] = [];
    const a = { [Symbol.asyncDispose]: async () => { calls.push("a"); } };
    const b = { [Symbol.asyncDispose]: async () => { calls.push("b"); } };
    const c = { [Symbol.asyncDispose]: async () => { calls.push("c"); } };
    const s = new Snabditel();
    // @ts-expect-error — exercising private surface deliberately
    const errs = await s.disposeAll([a, b, c]);
    expect(calls).toEqual(["c", "b", "a"]);
    expect(errs).toEqual([]);
  });

  test("disposeAll prefers asyncDispose when both present", async () => {
    const calls: string[] = [];
    const x = {
      [Symbol.dispose]: () => { calls.push("sync"); },
      [Symbol.asyncDispose]: async () => { calls.push("async"); },
    };
    const s = new Snabditel();
    // @ts-expect-error — private
    await s.disposeAll([x]);
    expect(calls).toEqual(["async"]);
  });

  test("disposeAll falls back to Symbol.dispose when only sync present", async () => {
    const calls: string[] = [];
    const x = { [Symbol.dispose]: () => { calls.push("sync"); } };
    const s = new Snabditel();
    // @ts-expect-error — private
    await s.disposeAll([x]);
    expect(calls).toEqual(["sync"]);
  });

  test("disposeAll skips items without dispose symbols", async () => {
    const x = { hello: "world" };
    const s = new Snabditel();
    // @ts-expect-error — private
    const errs = await s.disposeAll([x]);
    expect(errs).toEqual([]);
  });

  test("disposeAll collects errors and continues", async () => {
    const calls: string[] = [];
    const errA = new Error("a");
    const errC = new Error("c");
    const a = { [Symbol.asyncDispose]: async () => { calls.push("a"); throw errA; } };
    const b = { [Symbol.asyncDispose]: async () => { calls.push("b"); } };
    const c = { [Symbol.asyncDispose]: async () => { calls.push("c"); throw errC; } };
    const s = new Snabditel();
    // @ts-expect-error — private
    const errs = await s.disposeAll([a, b, c]);
    expect(calls).toEqual(["c", "b", "a"]);
    expect(errs).toEqual([errC, errA]);
  });
});
