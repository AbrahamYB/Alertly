import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

test("public report map refreshes existing markers after moderation changes", () => {
  const html = readPage("report.html");
  assert.ok(html.includes("const reportSignature = report =>"));
  assert.ok(html.includes("reportSignature(incoming) !== reportSignature(entry.data)"));
  assert.ok(html.includes("incomingById"));
});

test("every hazard surface uses the shared icon taxonomy", () => {
  for (const filename of ["index.html", "report.html", "moderation.html", "hazard-admin.html"]) {
    assert.ok(readPage(filename).includes('<script src="/hazard-ui.js"></script>'), `${filename} must load the shared hazard taxonomy`);
  }

  const context = {};
  vm.createContext(context);
  vm.runInContext(readPage("hazard-ui.js"), context);
  const taxonomy = context.AlertlyHazards;
  assert.equal(taxonomy.iconFor("earthquake"), "🫨");
  assert.notEqual(taxonomy.iconFor("earthquake"), "⚡");
  assert.equal(taxonomy.normalize("lightning storm"), "storm");
  assert.equal(taxonomy.iconFor("storm", "severe lightning and thunder"), "⛈️");
  assert.equal(taxonomy.iconFor("tornado"), "🌪️");
  assert.equal(taxonomy.normalize("storm surge"), "flood");
  assert.equal(new Set(taxonomy.categories.map(category => category.icon)).size, taxonomy.categories.length);
});
