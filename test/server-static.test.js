import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("AI re-checks quarantine NSFW media and restore plausible media", () => {
  const source = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  assert.match(source, /verdict === "nsfw"\) quarantineReportMedia/);
  assert.match(source, /verdict === "plausible"\) restoreQuarantinedMedia/);
});
