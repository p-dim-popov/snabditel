import { describe, expect, test } from "bun:test";
import {
  narrower,
  isWider,
  scopeOf,
  ownerName,
  mismatchError,
  effectiveScopedNoRunError,
} from "./scope-helpers";

describe("narrower", () => {
  test("returns the narrower of two scopes (lifetime ordering)", () => {
    expect(narrower("singleton", "singleton")).toBe("singleton");
    expect(narrower("singleton", "scoped")).toBe("scoped");
    expect(narrower("scoped", "singleton")).toBe("scoped");
    expect(narrower("scoped", "scoped")).toBe("scoped");
    expect(narrower("scoped", "transient")).toBe("transient");
    expect(narrower("transient", "scoped")).toBe("transient");
    expect(narrower("transient", "transient")).toBe("transient");
    expect(narrower("singleton", "transient")).toBe("transient");
  });
});

describe("isWider", () => {
  test("true when declared lifetime is longer than min", () => {
    expect(isWider("singleton", "scoped")).toBe(true);
    expect(isWider("singleton", "transient")).toBe(true);
    expect(isWider("scoped", "transient")).toBe(true);
  });
  test("false when declared <= min", () => {
    expect(isWider("singleton", "singleton")).toBe(false);
    expect(isWider("scoped", "scoped")).toBe(false);
    expect(isWider("scoped", "singleton")).toBe(false);
    expect(isWider("transient", "singleton")).toBe(false);
    expect(isWider("transient", "scoped")).toBe(false);
    expect(isWider("transient", "transient")).toBe(false);
  });
});

describe("scopeOf", () => {
  test("returns explicit injectionScope from SelfResolvable", () => {
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "scoped" })).toBe("scoped");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "transient" })).toBe("transient");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "singleton" })).toBe("singleton");
  });
  test("returns undefined when SelfResolvable has no injectionScope", () => {
    expect(scopeOf({ createInstance: () => ({}) })).toBeUndefined();
  });
  test("returns explicit injectionScope from class with static field", () => {
    class Foo { static readonly injectionScope = "scoped" as const; }
    expect(scopeOf(Foo)).toBe("scoped");
  });
  test("returns undefined for plain class without injectionScope", () => {
    class Bar {}
    expect(scopeOf(Bar)).toBeUndefined();
  });
});

describe("ownerName", () => {
  test("named class -> class name", () => {
    class Foo {}
    expect(ownerName(Foo)).toBe("Foo");
  });
  test("anonymous class -> 'anonymous class'", () => {
    const Anon = class {};
    Object.defineProperty(Anon, "name", { value: "" });
    expect(ownerName(Anon)).toBe("anonymous class");
  });
  test("SelfResolvable object literal -> 'anonymous SelfResolvable'", () => {
    expect(ownerName({ createInstance: () => ({}) })).toBe("anonymous SelfResolvable");
  });
  test("SelfResolvable instance with named constructor -> constructor name", () => {
    class MyFactory {
      createInstance() { return {}; }
    }
    expect(ownerName(new MyFactory() as unknown as Parameters<typeof ownerName>[0])).toBe("MyFactory");
  });
});

describe("mismatchError", () => {
  test("message includes owner name, declared scope, and min scope", () => {
    class B {}
    const err = mismatchError(B, "singleton", "scoped");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("B");
    expect(err.message).toContain("singleton");
    expect(err.message).toContain("scoped");
    expect(err.message).toMatch(/Cannot resolve B as singleton/);
    expect(err.message).toMatch(/depends on a scoped service/);
    expect(err.message).toMatch(/inherit 'scoped'/);
    expect(err.message).toMatch(/'scoped' or 'transient'/);
  });

  test("uses 'anonymous SelfResolvable' for object literal owner", () => {
    const err = mismatchError({ createInstance: () => ({}) }, "scoped", "transient");
    expect(err.message).toContain("anonymous SelfResolvable");
    expect(err.message).toContain("scoped");
    expect(err.message).toContain("transient");
  });
});

describe("effectiveScopedNoRunError", () => {
  test("message includes owner name and references inherited scoped dep + run() requirement", () => {
    class Owner {}
    const err = effectiveScopedNoRunError(Owner);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Owner");
    expect(err.message).toContain("'scoped'");
    expect(err.message).toContain("inherited from a scoped dependency");
    expect(err.message).toContain("run() scope");
  });
});
