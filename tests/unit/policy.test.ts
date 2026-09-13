import { describe, expect, it } from "vitest";
import { assertAllowedUrl } from "@browser-bridge/core";

describe("URL policy", () => {
  it("allows http/https/file", () => {
    expect(assertAllowedUrl("http://localhost:3000/").protocol).toBe("http:");
    expect(assertAllowedUrl("https://example.com/").protocol).toBe("https:");
    expect(assertAllowedUrl("file:///tmp/x.html").protocol).toBe("file:");
  });

  it("blocks credentials and exotic protocols", () => {
    expect(() => assertAllowedUrl("not-a-url")).toThrow();
    expect(() => assertAllowedUrl("ftp://example.com/x")).toThrow();
    expect(() => assertAllowedUrl("http://user:pass@example.com/")).toThrow();
  });
});
