import { describe, it, expect, vi } from 'vitest';
import { Snabditel, createToken } from './snabditel.js';

describe('Snabditel', () => {
  it('resolves a class via static getInstance', async () => {
    class Greeter {
      static async getInstance() {
        return { hello: () => 'hi' };
      }
    }
    const s = new Snabditel();
    const g = await s.resolve(Greeter);
    expect(g.hello()).toBe('hi');
  });

  it('caches scoped (default) resolves within the same scope', async () => {
    const spy = vi.fn(async () => ({ n: Math.random() }));
    class Svc {
      static getInstance = spy;
    }
    const s = new Snabditel();
    const a = await s.resolve(Svc);
    const b = await s.resolve(Svc);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent resolves of the same scoped class', async () => {
    let calls = 0;
    class Svc {
      static async getInstance() {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { id: calls };
      }
    }
    const s = new Snabditel();
    const [a, b, c] = await Promise.all([s.resolve(Svc), s.resolve(Svc), s.resolve(Svc)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('resolves nested deps via Snabditel passed to getInstance', async () => {
    class Db {
      static async getInstance() {
        return { name: 'db' };
      }
    }
    class Repo {
      constructor(public db: { name: string }) {}
      static async getInstance(s: Snabditel) {
        return new Repo(await s.resolve(Db));
      }
    }
    const s = new Snabditel();
    const repo = await s.resolve(Repo);
    expect(repo.db.name).toBe('db');
  });

  it('seed(Class, instance) short-circuits getInstance', async () => {
    const spy = vi.fn(async () => ({ tag: 'real' }));
    class Svc {
      static getInstance = spy;
    }
    const s = new Snabditel();
    const fake = { tag: 'fake' };
    s.seed(Svc, fake);
    const got = await s.resolve(Svc);
    expect(got).toBe(fake);
    expect(spy).not.toHaveBeenCalled();
  });

  it('supports the AppRequest token pattern', async () => {
    type FakeReq = { url: string };
    class AppRequest {
      static async getInstance(s: Snabditel) {
        return s.resolve<FakeReq>('request');
      }
    }
    const root = new Snabditel();
    const req: FakeReq = { url: '/x' };
    const result = await root.run(async (scope) => {
      scope.seed('request', req);
      return await scope.resolve(AppRequest);
    });
    expect(result).toBe(req);
  });

  it('resolve(missing token) rejects with a descriptive error', async () => {
    const s = new Snabditel();
    await expect(s.resolve('nope')).rejects.toThrow(/No instance seeded for token: nope/);
  });

  it('child scope inherits parent cache and seeds; child seeds do not leak up', async () => {
    class Svc {
      static async getInstance() {
        return { id: Math.random() };
      }
    }
    const root = new Snabditel();
    const rootSvc = await root.resolve(Svc);

    await root.run(async (child) => {
      const childSvc = await child.resolve(Svc);
      expect(childSvc).toBe(rootSvc); // inherited

      child.seed('local', 42);
      expect(await child.resolve('local')).toBe(42);
    });

    await expect(root.resolve('local')).rejects.toThrow();
  });

  it('sibling run scopes are isolated', async () => {
    class Svc {
      static async getInstance() {
        return { id: Math.random() };
      }
    }
    const root = new Snabditel();
    const a = await root.run(async (s) => {
      s.seed('marker', 'a');
      return await s.resolve('marker');
    });
    const b = await root.run(async (s) => {
      // 'marker' was only seeded in the previous (now-discarded) child
      return await s.resolve('marker').catch((e: Error) => e.message);
    });
    expect(a).toBe('a');
    expect(b).toMatch(/No instance seeded for token: marker/);
  });

  it('does not poison the cache when getInstance throws; next call retries', async () => {
    let calls = 0;
    class Flaky {
      static async getInstance() {
        calls++;
        if (calls === 1) throw new Error('first fail');
        return { ok: true };
      }
    }
    const s = new Snabditel();
    await expect(s.resolve(Flaky)).rejects.toThrow('first fail');
    const v = await s.resolve(Flaky);
    expect(v.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("'singleton' caches at the root scope across sibling run scopes", async () => {
    let calls = 0;
    class Db {
      static injectionScope = 'singleton' as const;
      static async getInstance() {
        calls++;
        return { id: calls };
      }
    }
    const root = new Snabditel();
    const fromChildA = await root.run((s) => s.resolve(Db));
    const fromChildB = await root.run((s) => s.resolve(Db));
    const fromRoot = await root.resolve(Db);
    expect(fromChildA).toBe(fromChildB);
    expect(fromChildA).toBe(fromRoot);
    expect(calls).toBe(1);
  });

  it("'transient' constructs a fresh instance every resolve and skips concurrent dedupe", async () => {
    let calls = 0;
    class Id {
      static injectionScope = 'transient' as const;
      static async getInstance() {
        calls++;
        return { n: calls };
      }
    }
    const s = new Snabditel();
    const a = await s.resolve(Id);
    const b = await s.resolve(Id);
    expect(a).not.toBe(b);
    expect(a.n).toBe(1);
    expect(b.n).toBe(2);

    calls = 0;
    const [c, d, e] = await Promise.all([s.resolve(Id), s.resolve(Id), s.resolve(Id)]);
    expect(calls).toBe(3);
    expect(new Set([c, d, e]).size).toBe(3);
  });

  it("omitted injectionScope behaves like 'scoped'", async () => {
    let calls = 0;
    class A {
      static async getInstance() {
        calls++;
        return { id: calls };
      }
    }
    class B {
      static injectionScope = 'scoped' as const;
      static async getInstance() {
        calls++;
        return { id: calls };
      }
    }
    const root = new Snabditel();

    // each child scope builds its own (scoped == one per scope)
    const a1 = await root.run((s) => s.resolve(A));
    const a2 = await root.run((s) => s.resolve(A));
    const b1 = await root.run((s) => s.resolve(B));
    const b2 = await root.run((s) => s.resolve(B));

    expect(a1).not.toBe(a2);
    expect(b1).not.toBe(b2);
  });

  it('does not poison the cache when getInstance throws synchronously; next call retries', async () => {
    let calls = 0;
    class Bang {
      static getInstance() {
        calls++;
        if (calls === 1) throw new Error('sync boom');
        return { ok: true };
      }
    }
    const s = new Snabditel();
    await expect(s.resolve(Bang)).rejects.toThrow('sync boom');
    const v = await s.resolve(Bang);
    expect(v.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('seed during in-flight resolve wins for future resolvers', async () => {
    let calls = 0;
    class Slow {
      static async getInstance() {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { tag: 'real' };
      }
    }
    const s = new Snabditel();
    const inflight = s.resolve(Slow);
    s.seed(Slow, { tag: 'fake' } as Awaited<ReturnType<typeof Slow.getInstance>>);
    const v = await s.resolve(Slow);
    expect(v.tag).toBe('fake');
    await inflight;
    const v2 = await s.resolve(Slow);
    expect(v2.tag).toBe('fake');
    expect(calls).toBe(1);
  });

  it('Token<T> gives type-safe seed and resolve', async () => {
    type Req = { url: string };
    const REQUEST = createToken<Req>('request');
    const s = new Snabditel();
    s.seed(REQUEST, { url: '/x' });
    const got = await s.resolve(REQUEST);
    expect(got.url).toBe('/x');
  });

  it('dispose calls Symbol.asyncDispose on cached instances', async () => {
    const closed: string[] = [];
    class Conn {
      static async getInstance() {
        return {
          [Symbol.asyncDispose]: async () => {
            closed.push('conn');
          },
        };
      }
    }
    const s = new Snabditel();
    await s.resolve(Conn);
    await s.dispose();
    expect(closed).toEqual(['conn']);
  });

  it('dispose calls Symbol.dispose on cached instances when async not present', async () => {
    const closed: string[] = [];
    class Sync {
      static async getInstance() {
        return {
          [Symbol.dispose]: () => {
            closed.push('sync');
          },
        };
      }
    }
    const s = new Snabditel();
    await s.resolve(Sync);
    await s.dispose();
    expect(closed).toEqual(['sync']);
  });

  it('run auto-disposes scoped instances cached on the child scope', async () => {
    const closed: string[] = [];
    class Scoped {
      static async getInstance() {
        return {
          [Symbol.asyncDispose]: async () => {
            closed.push('scoped');
          },
        };
      }
    }
    const root = new Snabditel();
    await root.run(async (s) => {
      await s.resolve(Scoped);
    });
    expect(closed).toEqual(['scoped']);
  });

  it('run does not dispose singletons cached on root', async () => {
    const closed: string[] = [];
    class Db {
      static injectionScope = 'singleton' as const;
      static async getInstance() {
        return {
          [Symbol.asyncDispose]: async () => {
            closed.push('db');
          },
        };
      }
    }
    const root = new Snabditel();
    await root.run(async (s) => {
      await s.resolve(Db);
    });
    expect(closed).toEqual([]);
    await root.dispose();
    expect(closed).toEqual(['db']);
  });

  it('run rethrows fn errors and still disposes the child', async () => {
    const closed: string[] = [];
    class Scoped {
      static async getInstance() {
        return {
          [Symbol.asyncDispose]: async () => {
            closed.push('scoped');
          },
        };
      }
    }
    const root = new Snabditel();
    await expect(
      root.run(async (s) => {
        await s.resolve(Scoped);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(closed).toEqual(['scoped']);
  });

  it('resolve on a disposed scope throws', async () => {
    class Svc {
      static async getInstance() {
        return { ok: true };
      }
    }
    const s = new Snabditel();
    await s.dispose();
    await expect(s.resolve(Svc)).rejects.toThrow(/disposed/);
  });

  it("manual seed of a 'transient' class is honored locally (seed wins over lifetime)", async () => {
    let calls = 0;
    class T {
      static injectionScope = 'transient' as const;
      static async getInstance() {
        calls++;
        return { n: calls };
      }
    }
    const s = new Snabditel();
    const fixed = { n: 999 };
    s.seed(T, fixed);
    const a = await s.resolve(T);
    const b = await s.resolve(T);
    expect(a).toBe(fixed);
    expect(b).toBe(fixed);
    expect(calls).toBe(0);
  });
});
