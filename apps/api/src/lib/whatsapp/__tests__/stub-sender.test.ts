import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StubSender } from "../stub-sender";

describe("StubSender", () => {
  it("returns ok=true with a stub message id for any input", async () => {
    const sender = new StubSender();
    const result = await sender.sendTemplate({
      to: "+60123456789",
      templateName: "new_claim_v1",
      languageCode: "en",
      variables: ["NX-2026-0042", "Ahmad", "1,234.50", "https://example/portal/claims/abc"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerMessageId).toMatch(/^stub-/);
    }
  });

  it("captures the last call for inspection in tests", async () => {
    const sender = new StubSender();
    await sender.sendTemplate({
      to: "+60123",
      templateName: "tpl",
      languageCode: "en",
      variables: ["a", "b"],
    });
    expect(sender.lastCall).toMatchObject({
      to: "+60123",
      templateName: "tpl",
      variables: ["a", "b"],
    });
  });
});

describe("StubSender PII redaction", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    logSpy.mockRestore();
  });

  it("does not log raw phone numbers", async () => {
    const sender = new StubSender();
    await sender.sendTemplate({
      to: "60123456789",
      templateName: "test",
      languageCode: "en",
      variables: [],
    });

    const logged = logSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).not.toContain("60123456789");
  });

  it("logs a redacted form ending with last 4 digits", async () => {
    const sender = new StubSender();
    await sender.sendTemplate({
      to: "60123456789",
      templateName: "test",
      languageCode: "en",
      variables: [],
    });

    const logged = logSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).toMatch(/\*+6789/);
  });

  it("preserves lastCall with raw phone (for test introspection)", async () => {
    const sender = new StubSender();
    await sender.sendTemplate({
      to: "60123456789",
      templateName: "test",
      languageCode: "en",
      variables: [],
    });
    // lastCall is for in-process test access, not external logs — raw phone preserved
    expect(sender.lastCall?.to).toBe("60123456789");
  });
});
