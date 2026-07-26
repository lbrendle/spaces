import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateWorkspace,
  signupDeniedMessage,
  signupPolicy,
} from "../lib/signup.ts";

test("production signup defaults to invite only", () => {
  const policy = signupPolicy(
    undefined,
    undefined,
    "spaces.example.com",
  );
  assert.equal(policy.mode, "invite_only");
  assert.equal(canCreateWorkspace("new@example.com", policy), false);
  assert.match(signupDeniedMessage(policy), /ask an owner for an invite/i);
});

test("local development remains open unless explicitly configured", () => {
  const policy = signupPolicy(undefined, undefined, "localhost:3000");
  assert.equal(policy.mode, "open");
  assert.equal(canCreateWorkspace("new@example.com", policy), true);
});

test("allowlist matching is normalized and exact", () => {
  const policy = signupPolicy(
    "allowlist",
    "owner@example.com, TEAMMATE@example.com",
    "spaces.example",
  );
  assert.equal(canCreateWorkspace("OWNER@example.com", policy), true);
  assert.equal(canCreateWorkspace("teammate@example.com", policy), true);
  assert.equal(canCreateWorkspace("other@example.com", policy), false);
});
