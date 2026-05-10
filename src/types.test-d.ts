// Type-level tests. Compiles iff public API and README examples typecheck.
// Not executed at runtime — `bun test` only matches `*.test.ts`.
// `bun run typecheck` covers this file via tsconfig.json.

import { Snabditel } from "./snabditel";
import { AlsSnabditel } from "./als";
import type { ASnabditel, SelfResolvable } from "./snabditel.types";

async function _readmeQuickstart() {
  const di = new Snabditel();

  class Logger {
    info(msg: string) {
      void msg;
    }
  }

  class UserService {
    static readonly injectionScope = "scoped";
    static async createInstance() {
      const logger = await di.resolve(Logger);
      return new UserService(logger);
    }

    constructor(private logger: Logger) {}

    greet(name: string) {
      this.logger.info(`hello ${name}`);
    }
  }

  await di.run(async () => {
    const users = await di.resolve(UserService);
    users.greet("ada");
  });
}

async function _readmeAsyncInit() {
  const di = new Snabditel();

  class AppConfig {
    static async createInstance() {
      return new AppConfig();
    }
    get(_key: string): unknown {
      return undefined;
    }
  }

  class Database {
    static async createInstance() {
      const config = await di.resolve(AppConfig);
      const conn = config.get("db.connectionString");
      return new Database(conn);
    }
    constructor(public conn: unknown) {}
  }

  const db = await di.resolve(Database);
  void db.conn;
}

async function _readmeRequestContext() {
  const di = new Snabditel();

  class RequestContext {
    static readonly injectionScope = "scoped";
    static createInstance() {
      return new RequestContext();
    }
    id = "abc";
  }

  await di.run(async () => {
    const a = await di.resolve(RequestContext);
    const b = await di.resolve(RequestContext);
    void a.id;
    void b.id;
  });
}

async function _plainClassSingleton() {
  const di = new Snabditel();
  class Foo {
    hi() {
      return 1;
    }
  }
  const f: Foo = await di.resolve(Foo);
  f.hi();
}

async function _seedFlavors() {
  const di = new Snabditel();

  di.seed("CFG", { url: "x" });
  const cfg = await di.resolve<{ url: string }>("CFG");
  void cfg.url;

  const TOK = Symbol("t");
  di.seed(TOK, 42);
  const n = await di.resolve<number>(TOK);
  void n.toFixed();

  class Foo {
    hi(): string {
      return "real";
    }
  }
  const fake: Foo = { hi: () => "fake" };
  di.seed(Foo, fake);
}

async function _selfResolvableObjectScoped() {
  const di = new Snabditel();
  const r: SelfResolvable<{ id: number }> = {
    createInstance: async () => ({ id: 1 }),
    injectionScope: "scoped",
  };
  await di.run(async () => {
    const got = await di.resolve(r);
    void got.id;
  });
}

async function _alsVariantParallelRuns() {
  const di = new AlsSnabditel();
  class Logger {}
  class RequestHandler {
    static async createInstance() {
      return new RequestHandler(await di.resolve(Logger));
    }
    constructor(private logger: Logger) {
      void this.logger;
    }
    handle() {}
  }
  await Promise.all([
    di.run(async () => {
      (await di.resolve(RequestHandler)).handle();
    }),
    di.run(async () => {
      (await di.resolve(RequestHandler)).handle();
    }),
  ]);
}

async function _resolveTypeInference() {
  const di = new Snabditel();
  class Foo {
    x = 1;
  }
  const foo: Foo = await di.resolve(Foo);
  void foo.x;

  const r: SelfResolvable<{ y: string }> = {
    createInstance: () => ({ y: "z" }),
  };
  const v: { y: string } = await di.resolve(r);
  void v.y;
}

async function _scopedResolverArg() {
  const di = new Snabditel();
  class AuthToken {
    static readonly injectionScope = "scoped";
    static createInstance() { return new AuthToken(); }
    value = "x";
  }
  class Api {
    static readonly injectionScope = "transient";
    static async createInstance(s: ASnabditel) {
      return new Api(await s.resolve(AuthToken));
    }
    constructor(public auth: AuthToken) {}
  }
  await di.run(async (s) => {
    const a: Api = await s.resolve(Api);
    void a.auth.value;
  });
}

async function _runCallbackReceivesScopedResolver() {
  const di = new Snabditel();
  await di.run(async (s) => {
    const v = await s.resolve<{ x: number }>("X");
    void v.x;
  });
  await new AlsSnabditel().run(async () => {
    // ALS variant lets you ignore s entirely.
  });
}
