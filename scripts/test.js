#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");

function runNode(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function seedRuntime(runtimeDir) {
  const dataDir = path.join(runtimeDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "reports.json"), `${JSON.stringify([{
    id: "test-public-sanitization",
    type: "Flood",
    text: "Seed report for public response sanitization",
    severity: "medium",
    status: "active",
    moderationStatus: "approved",
    verified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lat: 15.5,
    lng: -87.65,
    geometry: { type: "Point", coordinates: [-87.65, 15.5] },
    auditLog: [{ action: "test-only" }],
    removalRequests: [{ id: "private-test-request", reason: "private" }],
    submitterIp: "127.0.0.1",
    moderatorNotes: "private test note",
  }], null, 2)}\n`);
  fs.writeFileSync(path.join(runtimeDir, "hazards.geojson"), `${JSON.stringify({ type: "FeatureCollection", features: [] }, null, 2)}\n`);
  return dataDir;
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited early.\n${output()}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the test server.\n${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function runHttpTest(testFile) {
  const runtimeDir = path.join(root, `tmp_test_${crypto.randomUUID()}`);
  const dataDir = seedRuntime(runtimeDir);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "test",
    ENABLE_AUTOMATION: "false",
    DATA_DIR: dataDir,
    BACKUPS_DIR: path.join(runtimeDir, "backups"),
    UPLOADS_DIR: path.join(runtimeDir, "uploads"),
    HAZARDS_FILE: path.join(runtimeDir, "hazards.geojson"),
    ALERTLY_TEST_URL: baseUrl,
    ALERTLY_PUBLIC_URL: baseUrl,
    CHAT_AI_API_KEY: "",
    REPORT_AI_API_KEY: "",
    AI_API_KEY: "",
    GROQ_API_KEY: "",
  };

  let logs = "";
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });

  try {
    await waitForServer(baseUrl, child, () => logs);
    const args = testFile.endsWith(".test.js")
      ? ["--test", "--test-concurrency=1", testFile]
      : [testFile];
    const status = runNode(args, env);
    if (status !== 0) throw new Error(`${testFile} failed.\n${logs}`);
  } finally {
    await stopServer(child);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

const unitTests = fs.readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js") && name !== "api.test.js")
  .map((name) => path.join("test", name));

if (runNode(["--test", "--test-concurrency=1", ...unitTests]) !== 0) process.exit(1);
await runHttpTest(path.join("test", "api.test.js"));
await runHttpTest(path.join("test", "staff-http-smoke.js"));

console.log("All Alertly tests passed.");
