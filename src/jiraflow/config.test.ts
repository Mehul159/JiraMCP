import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { branchNameFromPattern, slugFromSummary } from "./config.js";

describe("config", () => {
  it("slugFromSummary", () => {
    assert.equal(slugFromSummary("Add Todo List!!"), "add-todo-list");
  });

  it("branchNameFromPattern", () => {
    const b = branchNameFromPattern(
      "{type}/{ticket}-{slug}",
      "KAN-1",
      "Fix login bug",
      "Bug",
    );
    assert.equal(b, "fix/KAN-1-fix-login-bug");
  });
});
