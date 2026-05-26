import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fail, ok, toMcpContent } from "./response.js";

describe("response", () => {
  it("envelope shape", () => {
    const r = ok("done", { x: 1 });
    assert.equal(r.success, true);
    const mcp = toMcpContent(r);
    const parsed = JSON.parse(mcp.content[0].text);
    assert.equal(parsed.message, "done");
  });

  it("fail shape", () => {
    const r = fail("nope", { recovery_steps: ["retry"] });
    assert.equal(r.success, false);
  });
});
