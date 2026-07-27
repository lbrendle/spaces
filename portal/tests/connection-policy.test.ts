import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canConnectProvider,
  canUseConnection,
  connectionAudience,
} from "../lib/connection-policy.ts";

describe("connection sharing policy", () => {
  it("keeps personal providers private to their owner", () => {
    assert.equal(connectionAudience("github"), "personal");
    assert.equal(connectionAudience("google"), "personal");
    assert.equal(connectionAudience("microsoft"), "personal");
    assert.equal(canUseConnection("google", "owner-a", "owner-a"), true);
    assert.equal(canUseConnection("google", "owner-a", "member-b"), false);
    assert.equal(canUseConnection("github", "owner-a", "member-b"), false);
  });

  it("shares social publishing providers with the workspace", () => {
    for (const provider of ["meta", "tiktok", "x"]) {
      assert.equal(connectionAudience(provider), "workspace");
      assert.equal(canUseConnection(provider, "owner-a", "member-b"), true);
    }
  });

  it("lets members connect personal accounts but not workspace social accounts", () => {
    assert.equal(canConnectProvider("github", "member"), true);
    assert.equal(canConnectProvider("google", "member"), true);
    assert.equal(canConnectProvider("x", "member"), false);
    assert.equal(canConnectProvider("x", "admin"), true);
  });
});
