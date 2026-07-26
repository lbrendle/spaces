import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const server = new URL("./hq-mcp-server.mjs", import.meta.url);

test("lists and approval-queues the social publishing tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaces-mcp-"));
  await mkdir(join(root, ".hq"));
  await writeFile(
    join(root, ".hq", "mcp-tools.json"),
    `${JSON.stringify({
      version: 1,
      tools: [
        {
          name: "spaces_publish_social",
          description: "Publish through a connected account.",
          effect: "propose",
          readOnly: false,
          inputSchema: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["instagram", "tiktok"] },
              copy: { type: "string" },
              media_url: { type: "string" },
            },
            required: ["platform", "copy", "media_url"],
            additionalProperties: false,
          },
        },
      ],
    }, null, 2)}\n`,
  );

  const child = spawn(process.execPath, [server.pathname, root], {
    cwd: root,
    env: { ...process.env, SPACES_PROJECT_ID: "project-1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {} },
  });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "spaces_publish_social",
      arguments: {
        platform: "instagram",
        copy: "A reviewed launch post",
        media_url: "https://example.com/image.png",
      },
    },
  });
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);

  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, "hq");
  assert.equal(responses[1].result.tools[0].name, "spaces_publish_social");
  assert.match(responses[1].result.tools[0].description, /human to approve/i);
  assert.match(responses[2].result.content[0].text, /holding it for a human to approve/i);

  const queued = JSON.parse(
    (await readFile(join(root, ".hq", "actions.jsonl"), "utf8")).trim(),
  );
  assert.equal(queued.op, "spaces_publish_social");
  assert.equal(queued.project_id, "project-1");
  assert.deepEqual(queued.args, {
    platform: "instagram",
    copy: "A reviewed launch post",
    media_url: "https://example.com/image.png",
  });
});
