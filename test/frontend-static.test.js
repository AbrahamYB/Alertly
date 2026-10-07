import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readPage(filename) {
  return fs.readFileSync(path.join(projectRoot, filename), "utf8");
}

test("all application pages contain syntactically valid inline JavaScript", () => {
  for (const filename of ["index.html", "report.html", "moderation.html", "hazard-admin.html", "staff.html"]) {
    const html = readPage(filename);
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .filter(source => source.trim());
    assert.ok(scripts.length > 0, `${filename} should contain application JavaScript`);
    for (const source of scripts) {
      assert.doesNotThrow(() => new Function(source), `${filename} contains invalid inline JavaScript`);
    }
  }
});

test("moderation page retains every protected workflow connection", () => {
  const html = readPage("moderation.html");
  for (const required of [
    "/api/moderation/reports",
    "/verify-ai",
    "/removal-requests/",
    'id="approveBtn"',
    'id="rejectBtn"',
    'id="setPendingBtn"',
    'id="deleteBtn"',
    'id="saveAreaBtn"'
  ]) {
    assert.ok(html.includes(required), `moderation.html is missing ${required}`);
  }
});
