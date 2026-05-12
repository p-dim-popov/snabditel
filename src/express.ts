import type { AlsSnabditel } from "./als";

// Structural-minimum Express types — no `express` peer dep required.
// `any` on the parameters lets `app.use(expressScope(di))` typecheck against
// Express's overloaded `RequestHandler` without us importing `@types/express`.
type ReqLike = { log?: { error?: (e: unknown) => void } };
type ResLike = { once: (event: string, cb: () => void) => unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExpressMiddleware = (req: any, res: any, next: any) => void;

export function expressScope(di: AlsSnabditel): ExpressMiddleware {
  return (req: ReqLike, res: ResLike, next: (err?: unknown) => void) => {
    di.run(async () => {
      const closed = new Promise<void>((r) => res.once("close", r));
      next();
      await closed;
    }).catch((err) => {
      if (req.log?.error) req.log.error(err);
      else console.error("[snabditel/express] scope error:", err);
    });
  };
}
