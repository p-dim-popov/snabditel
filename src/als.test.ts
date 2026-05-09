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

  test("resolve string token returns seeded value", async () => {
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

  test("plain class resolves and caches as singleton (no deps)", async () => {
    class Foo {}
    const s = new AlsSnabditel();
    const a = await s.resolve(Foo);
    const b = await s.resolve(Foo);
    expect(a).toBeInstanceOf(Foo);
    expect(a).toBe(b);
  });

  test("SelfResolvable singleton: createInstance awaited and cached", async () => {
    let calls = 0;
    const r: SelfResolvable<{ n: number }> = {
      createInstance: async () => {
        calls++;
        return { n: 7 };
      },
    };
    const s = new AlsSnabditel();
    const a = await s.resolve(r);
    const b = await s.resolve(r);
    expect(a.n).toBe(7);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("explicit scoped: same instance within run, different across runs", async () => {
    const r: SelfResolvable<{ id: number }> = {
      createInstance: () => ({ id: Math.random() }),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const a = await s.run(async () => {
      const x = await s.resolve(r);
      const y = await s.resolve(r);
      expect(x).toBe(y);
      return x;
    });
    const b = await s.run(async () => s.resolve(r));
    expect(a).not.toBe(b);
  });

  test("explicit transient: new instance each resolve, no cache", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new AlsSnabditel();
    const a = await s.resolve(r);
    const b = await s.resolve(r);
    expect(a).not.toBe(b);
  });

  test("explicit scoped resolved outside run throws", async () => {
    const r: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    await expect(s.resolve(r)).rejects.toThrow(/run\(\) scope/);
  });

  test("unset owner depending on scoped dep becomes scoped", async () => {
    const A: SelfResolvable<{ tag: "A" }> = {
      createInstance: () => ({ tag: "A" }),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const B: SelfResolvable<{ a: { tag: "A" } }> = {
      // no injectionScope
      createInstance: async () => ({ a: await s.resolve(A) }),
    };

    const b1 = await s.run(async () => s.resolve(B));
    const b2 = await s.run(async () => s.resolve(B));
    expect(b1).not.toBe(b2);
    expect(b1.a).not.toBe(b2.a);
  });

  test("unset owner depending only on singleton stays singleton", async () => {
    class Logger {}
    const s = new AlsSnabditel();
    const Wrapper: SelfResolvable<{ l: Logger }> = {
      createInstance: async () => ({ l: await s.resolve(Logger) }),
    };

    const w1 = await s.resolve(Wrapper);
    const w2 = await s.resolve(Wrapper);
    expect(w1).toBe(w2);
  });

  test("unset owner depending on transient dep becomes transient", async () => {
    const T: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ t: object }> = {
      createInstance: async () => ({ t: await s.resolve(T) }),
    };

    const o1 = await s.resolve(Owner);
    const o2 = await s.resolve(Owner);
    expect(o1).not.toBe(o2);
  });

  test("mixed deps {singleton, scoped} on unset owner -> scoped", async () => {
    class Singleton {}
    const Scoped: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ sg: Singleton; sc: object }> = {
      createInstance: async () => ({
        sg: await s.resolve(Singleton),
        sc: await s.resolve(Scoped),
      }),
    };

    const o1 = await s.run(async () => s.resolve(Owner));
    const o2 = await s.run(async () => s.resolve(Owner));
    expect(o1).not.toBe(o2);
  });

  test("mixed deps {singleton, scoped, transient} on unset owner -> transient", async () => {
    class Singleton {}
    const Scoped: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const Transient: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ sg: Singleton; sc: object; tr: object }> = {
      createInstance: async () => ({
        sg: await s.resolve(Singleton),
        sc: await s.resolve(Scoped),
        tr: await s.resolve(Transient),
      }),
    };

    const [o1, o2] = await s.run(async () => [
      await s.resolve(Owner),
      await s.resolve(Owner),
    ]);
    expect(o1).not.toBe(o2);
  });

  test("string seed dep scope inferred from cache location: scoped seed -> owner scoped", async () => {
    const s = new AlsSnabditel();
    s.seed("CFG", { v: 1 });
    const Owner: SelfResolvable<{ cfg: { v: number } }> = {
      createInstance: async () => ({ cfg: await s.resolve<{ v: number }>("CFG") }),
    };

    await s.run(async () => {
      s.seed("CFG", { v: 2 }, { injectionScope: "scoped" });
      const o1 = await s.resolve(Owner);
      expect(o1.cfg.v).toBe(2);
    });
    await s.run(async () => {
      s.seed("CFG", { v: 3 }, { injectionScope: "scoped" });
      const o2 = await s.resolve(Owner);
      expect(o2.cfg.v).toBe(3);
    });
  });

  test("explicit singleton + scoped dep throws clear error", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    class B {
      static readonly injectionScope = "singleton" as const;
      static async createInstance() {
        await s.resolve(A);
        return new B();
      }
    }

    await expect(s.run(async () => s.resolve(B))).rejects.toThrow(
      /Cannot resolve B as singleton: depends on a scoped service/,
    );
  });

  test("explicit singleton + transient dep throws", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new AlsSnabditel();
    class B {
      static readonly injectionScope = "singleton" as const;
      static async createInstance() {
        await s.resolve(A);
        return new B();
      }
    }

    await expect(s.resolve(B)).rejects.toThrow(
      /Cannot resolve B as singleton: depends on a transient service/,
    );
  });

  test("explicit scoped + transient dep throws", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "transient",
    };
    const s = new AlsSnabditel();
    class B {
      static readonly injectionScope = "scoped" as const;
      static async createInstance() {
        await s.resolve(A);
        return new B();
      }
    }

    await expect(s.run(async () => s.resolve(B))).rejects.toThrow(
      /Cannot resolve B as scoped: depends on a transient service/,
    );
  });

  test("explicit transient + scoped dep ok", async () => {
    const A: SelfResolvable<{ tag: "A" }> = {
      createInstance: () => ({ tag: "A" }),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const B: SelfResolvable<{ a: { tag: "A" } }> = {
      createInstance: async () => ({ a: await s.resolve(A) }),
      injectionScope: "transient",
    };

    await s.run(async () => {
      const b1 = await s.resolve(B);
      const b2 = await s.resolve(B);
      expect(b1).not.toBe(b2);          // transient: fresh each time
      expect(b1.a).toBe(b2.a);          // shared scoped A within run
    });
  });

  test("explicit scoped + singleton dep ok", async () => {
    class A {}
    const s = new AlsSnabditel();
    const B: SelfResolvable<{ a: A }> = {
      createInstance: async () => ({ a: await s.resolve(A) }),
      injectionScope: "scoped",
    };

    await s.run(async () => {
      const b = await s.resolve(B);
      expect(b.a).toBeInstanceOf(A);
    });
  });

  test("validation error aborts createInstance early (side effects after first violating resolve do not run)", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    let sideEffect = 0;
    class B {
      static readonly injectionScope = "singleton" as const;
      static async createInstance() {
        await s.resolve(A);
        sideEffect++;          // must NOT run — bubble should throw before reaching here
        return new B();
      }
    }

    await expect(s.run(async () => s.resolve(B))).rejects.toThrow(/singleton/);
    expect(sideEffect).toBe(0);
  });

  test("concurrent same-run resolves of unset-scope token: single build (lock)", async () => {
    let calls = 0;
    const Slow: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { id: calls };
      },
    };
    const s = new AlsSnabditel();
    const [a, b, c] = await Promise.all([
      s.resolve(Slow),
      s.resolve(Slow),
      s.resolve(Slow),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toBe(1);
  });

  test("concurrent cross-run resolves: unset -> singleton -> single build", async () => {
    let calls = 0;
    const Slow: SelfResolvable<{ id: number }> = {
      createInstance: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { id: calls };
      },
    };
    const s = new AlsSnabditel();
    const [a, b] = await Promise.all([
      s.run(async () => s.resolve(Slow)),
      s.run(async () => s.resolve(Slow)),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("concurrent cross-run resolves: unset -> scoped -> each run rebuilds with own value", async () => {
    let calls = 0;
    const A: SelfResolvable<{ tag: "A"; n: number }> = {
      createInstance: () => ({ tag: "A", n: ++calls }),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ a: { tag: "A"; n: number } }> = {
      createInstance: async () => ({ a: await s.resolve(A) }),
    };

    const [o1, o2] = await Promise.all([
      s.run(async () => s.resolve(Owner)),
      s.run(async () => s.resolve(Owner)),
    ]);
    expect(o1).not.toBe(o2);
    expect(o1.a).not.toBe(o2.a);
  });

  test("builder rejects: all waiters get same rejection, no cache", async () => {
    let calls = 0;
    const Bad: SelfResolvable<{ ok: boolean }> = {
      createInstance: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("boom");
      },
    };
    const s = new AlsSnabditel();
    const results = await Promise.allSettled([
      s.resolve(Bad),
      s.resolve(Bad),
      s.resolve(Bad),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toBe("boom");
      }
    }
    expect(calls).toBe(1);
  });

  test("scoped dep resolved outside run throws (blocks owner with effective scope = scoped)", async () => {
    const A: SelfResolvable<object> = {
      createInstance: () => ({}),
      injectionScope: "scoped",
    };
    const s = new AlsSnabditel();
    const Owner: SelfResolvable<{ a: object }> = {
      createInstance: async () => ({ a: await s.resolve(A) }),
    };

    await expect(s.resolve(Owner)).rejects.toThrow(/run\(\) scope/);
  });
});
