import { describe, expect, test } from "bun:test";
import { writeSeed, readSeedToken } from "./seed-helpers";

describe("writeSeed", () => {
  test("default singleton -> writes to singletons map", () => {
    const singletons = new Map<unknown, unknown>();
    writeSeed(singletons, () => null, "K", 1);
    expect(singletons.get("K")).toBe(1);
  });

  test("explicit singleton -> writes to singletons map", () => {
    const singletons = new Map<unknown, unknown>();
    writeSeed(singletons, () => null, "K", 1, { injectionScope: "singleton" });
    expect(singletons.get("K")).toBe(1);
  });

  test("scoped + active scope -> writes to scope map", () => {
    const singletons = new Map<unknown, unknown>();
    const scope = new Map<unknown, unknown>();
    writeSeed(singletons, () => scope, "K", 1, { injectionScope: "scoped" });
    expect(scope.get("K")).toBe(1);
    expect(singletons.has("K")).toBe(false);
  });

  test("scoped + no scope -> throws", () => {
    expect(() =>
      writeSeed(new Map(), () => null, "K", 1, { injectionScope: "scoped" }),
    ).toThrow(/run\(\) scope/);
  });

  test("transient -> throws", () => {
    expect(() =>
      writeSeed(new Map(), () => null, "K", 1, { injectionScope: "transient" }),
    ).toThrow(/transient/);
  });
});

describe("readSeedToken", () => {
  test("scope hit returns value + 'scoped'", async () => {
    const singletons = new Map<unknown, unknown>();
    const scope = new Map<unknown, unknown>([["K", 9]]);
    const r = await readSeedToken(singletons, scope, "K");
    expect(r).toEqual({ value: 9, source: "scoped" });
  });

  test("singleton hit returns value + 'singleton'", async () => {
    const singletons = new Map<unknown, unknown>([["K", 7]]);
    const r = await readSeedToken(singletons, null, "K");
    expect(r).toEqual({ value: 7, source: "singleton" });
  });

  test("scope hit shadows singleton", async () => {
    const singletons = new Map<unknown, unknown>([["K", 1]]);
    const scope = new Map<unknown, unknown>([["K", 2]]);
    const r = await readSeedToken(singletons, scope, "K");
    expect(r).toEqual({ value: 2, source: "scoped" });
  });

  test("miss throws Unknown token", async () => {
    await expect(readSeedToken(new Map(), null, "MISSING")).rejects.toThrow(
      /Unknown token/,
    );
  });

  test("awaits cached promise values", async () => {
    const singletons = new Map<unknown, unknown>([["K", Promise.resolve(42)]]);
    const r = await readSeedToken(singletons, null, "K");
    expect(r).toEqual({ value: 42, source: "singleton" });
  });
});
