import { describe, it, expect } from 'vitest';
import { Snabditel } from './snabditel.js';
import { AmbientSnabditel } from './ambient.js';

describe('AmbientSnabditel', () => {
  it('exposes the current scope inside run()', async () => {
    const a = new AmbientSnabditel();
    class Svc {
      static async getInstance() {
        return { ok: true };
      }
    }
    const result = await a.run(async () => {
      const got = await a.resolve(Svc);
      return got.ok;
    });
    expect(result).toBe(true);
  });

  it('current() throws outside run()', () => {
    const a = new AmbientSnabditel();
    expect(() => a.current()).toThrow(/No ambient Snabditel scope/);
  });

  it('resolve()/seed() throw outside run()', () => {
    const a = new AmbientSnabditel();
    expect(() => a.resolve('x')).toThrow(/No ambient Snabditel scope/);
    expect(() => a.seed('x', 1)).toThrow(/No ambient Snabditel scope/);
  });

  it('tryCurrent() returns undefined outside, scope inside', async () => {
    const a = new AmbientSnabditel();
    expect(a.tryCurrent()).toBeUndefined();
    await a.run(async (child) => {
      expect(a.tryCurrent()).toBe(child);
    });
  });

  it('seed and resolve route through the current scope', async () => {
    const a = new AmbientSnabditel();
    type Req = { url: string };
    await a.run(async () => {
      a.seed<Req>('request', { url: '/x' });
      const got = await a.resolve<Req>('request');
      expect(got.url).toBe('/x');
    });
  });

  it('first run() creates a child of the root; child seeds do not leak to root', async () => {
    const a = new AmbientSnabditel();
    await a.run(async () => {
      a.seed('marker', 'in-child');
      expect(await a.resolve('marker')).toBe('in-child');
    });
    await expect(a.run(async () => a.resolve('marker'))).rejects.toThrow();
  });

  it('nested run() creates a child of the current scope and pops correctly', async () => {
    const a = new AmbientSnabditel();
    const seen: Snabditel[] = [];
    await a.run(async (childA) => {
      seen.push(a.current());
      await a.run(async (childB) => {
        seen.push(a.current());
        expect(a.current()).toBe(childB);
      });
      expect(a.current()).toBe(childA);
      seen.push(a.current());
    });
    expect(seen[0]).toBe(seen[2]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('accepts an explicit root via constructor', async () => {
    const root = new Snabditel();
    class Db {
      static injectionScope = 'singleton' as const;
      static async getInstance() {
        return { id: 'real-db' };
      }
    }
    await root.resolve(Db); // pre-cache on root
    const a = new AmbientSnabditel(root);
    const fromAmbient = await a.run(() => a.resolve(Db));
    const fromRoot = await root.resolve(Db);
    expect(fromAmbient).toBe(fromRoot);
    expect(a.root).toBe(root);
  });

  it('separate AmbientSnabditel instances are isolated', async () => {
    const a = new AmbientSnabditel();
    const b = new AmbientSnabditel();
    await a.run(async () => {
      expect(a.tryCurrent()).toBeDefined();
      expect(b.tryCurrent()).toBeUndefined();
    });
  });

  it('run() auto-disposes the child scope on exit', async () => {
    const a = new AmbientSnabditel();
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
    await a.run(async () => {
      await a.resolve(Scoped);
    });
    expect(closed).toEqual(['scoped']);
  });

  it('dispose() disposes the root', async () => {
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
    const a = new AmbientSnabditel();
    await a.run(async () => {
      await a.resolve(Db);
    });
    expect(closed).toEqual([]); // singleton lives on root
    await a.dispose();
    expect(closed).toEqual(['db']);
  });
});
