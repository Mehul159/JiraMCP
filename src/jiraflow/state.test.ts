import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, canTransition } from "./state.js";

describe("state", () => {
  it("allows ticket_loaded to context_prepared", () => {
    assert.ok(canTransition("ticket_loaded", "context_prepared"));
  });

  it("blocks skip to feature_branch", () => {
    const r = assertTransition("ticket_loaded", "feature_branch_created");
    assert.equal(r.ok, false);
  });
});
