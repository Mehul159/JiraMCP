import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMediaConfig } from "./media-context.js";
import { extractMediaRefs } from "./adf.js";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("media-context", () => {
  it("resolveMediaConfig honors repo override mode=off", () => {
    const cfg = resolveMediaConfig({ enabled: true, mode: "off" });
    assert.equal(cfg.mode, "off");
    assert.equal(cfg.enabled, true);
  });

  it("resolveMediaConfig defaults are sane", () => {
    const cfg = resolveMediaConfig();
    assert.equal(cfg.mode, "full");
    assert.ok(cfg.maxFiles > 0);
    assert.ok(cfg.maxFileBytes > 0);
    assert.ok(cfg.vision.baseUrl.startsWith("http"));
  });

  it("resolveMediaConfig is OFF by default even when a vision key is present (opt-in)", () => {
    const savedEnabled = process.env.MEDIA_ANALYSIS_ENABLED;
    const savedKey = process.env.VISION_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    try {
      delete process.env.MEDIA_ANALYSIS_ENABLED;
      process.env.VISION_API_KEY = "sk-test-key";
      delete process.env.OPENAI_API_KEY;
      const cfg = resolveMediaConfig();
      assert.equal(cfg.enabled, false);
      // Key is still available so analysis is possible when explicitly requested.
      assert.equal(cfg.vision.apiKey, "sk-test-key");
    } finally {
      restore("MEDIA_ANALYSIS_ENABLED", savedEnabled);
      restore("VISION_API_KEY", savedKey);
      restore("OPENAI_API_KEY", savedOpenai);
    }
  });

  it("resolveMediaConfig honors MEDIA_ANALYSIS_ENABLED=true", () => {
    const saved = process.env.MEDIA_ANALYSIS_ENABLED;
    try {
      process.env.MEDIA_ANALYSIS_ENABLED = "true";
      assert.equal(resolveMediaConfig().enabled, true);
    } finally {
      restore("MEDIA_ANALYSIS_ENABLED", saved);
    }
  });

  it("extractMediaRefs finds inline media nodes", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "mediaSingle",
          content: [
            { type: "media", attrs: { id: "abc-123", type: "file", alt: "screenshot" } },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    };
    const refs = extractMediaRefs(adf);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, "abc-123");
    assert.equal(refs[0].alt, "screenshot");
  });

  it("extractMediaRefs returns empty for plain text", () => {
    assert.deepEqual(extractMediaRefs({ type: "paragraph" }), []);
  });
});
