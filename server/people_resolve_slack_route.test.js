import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const thisFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFilePath), "..");

async function pickPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve test port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready within timeout");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(killTimer);
  }
}

test("GET /people/resolve/slack returns 200 for mapped users and 404 for unmapped users", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcc-people-resolve-slack-"));
  const dbPath = path.join(tmpDir, "resolve-slack.db");
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const originalDbPath = process.env.CONTROL_CENTER_DB_PATH;
  const originalPccDbPath = process.env.PCC_DATABASE_PATH;
  const originalPort = process.env.CONTROL_CENTER_PORT;
  const originalHost = process.env.CONTROL_CENTER_HOST;

  process.env.CONTROL_CENTER_DB_PATH = dbPath;
  process.env.PCC_DATABASE_PATH = dbPath;
  process.env.CONTROL_CENTER_PORT = String(port);
  process.env.CONTROL_CENTER_HOST = "127.0.0.1";

  const { createPerson, createPersonIdentifier, getDb } = await import("./db.ts");
  const person = createPerson({ name: "Slack Route User" });
  const identifier = createPersonIdentifier({
    person_id: person.id,
    type: "other",
    value: "slack:T-ROUTE:U-ROUTE",
  });
  assert.ok(identifier);
  getDb().close();

  const child = spawn(process.execPath, ["--import", "tsx/esm", "server/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore"],
  });

  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDbPath === undefined) {
      delete process.env.CONTROL_CENTER_DB_PATH;
    } else {
      process.env.CONTROL_CENTER_DB_PATH = originalDbPath;
    }
    if (originalPccDbPath === undefined) {
      delete process.env.PCC_DATABASE_PATH;
    } else {
      process.env.PCC_DATABASE_PATH = originalPccDbPath;
    }
    if (originalPort === undefined) {
      delete process.env.CONTROL_CENTER_PORT;
    } else {
      process.env.CONTROL_CENTER_PORT = originalPort;
    }
    if (originalHost === undefined) {
      delete process.env.CONTROL_CENTER_HOST;
    } else {
      process.env.CONTROL_CENTER_HOST = originalHost;
    }
  });

  await waitForServer(baseUrl, child);

  const mappedResponse = await fetch(
    `${baseUrl}/people/resolve/slack?team_id=T-ROUTE&user_id=U-ROUTE`
  );
  assert.equal(mappedResponse.status, 200);
  const mappedBody = await mappedResponse.json();
  assert.equal(mappedBody.person?.id, person.id);

  const unmappedResponse = await fetch(
    `${baseUrl}/people/resolve/slack?team_id=T-ROUTE&user_id=U-MISSING`
  );
  assert.equal(unmappedResponse.status, 404);
  const unmappedBody = await unmappedResponse.json();
  assert.equal(unmappedBody.error, "person not found");
});
