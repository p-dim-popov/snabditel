import type { AlsSnabditel } from "./als";

type Req = { log?: { error?: (e: unknown) => void } };
type Res = { once: (event: "close", cb: () => void) => void };
type Next = (err?: unknown) => void;

export function expressScope(di: AlsSnabditel) {
  return (req: Req, res: Res, next: Next): void => {
    di.run(async () => {
      next();
      await new Promise<void>((r) => res.once("close", r));
    }).catch((err) => {
      if (req.log?.error) req.log.error(err);
      else console.error("[snabditel/express] scope error:", err);
    });
  };
}
