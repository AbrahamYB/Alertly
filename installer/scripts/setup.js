#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const SCHEMA_VERSION = 1;
const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const configDir = path.join(rootDir, "config");
const configPath = path.join(configDir, "installation.json");
const historyPath = path.join(configDir, "installation-history.jsonl");

function command(name, args = []) {
  try {
    return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readOsRelease() {
  try {
    return Object.fromEntries(
      fs.readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .filter(line => line.includes("="))
        .map(line => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1).replace(/^\"|\"$/g, "")];
        })
    );
  } catch {
    return {};
  }
}

export function detectHost() {
  const release = readOsRelease();
  const graphics = command("sh", ["-lc", "command -v lspci >/dev/null && lspci | grep -Ei 'vga|3d|display' || true"]);
  const gpuBrands = [
    ["nvidia", /nvidia/i],
    ["amd", /advanced micro devices|amd\/ati|radeon/i],
    ["intel", /intel/i],
  ].filter(([, pattern]) => pattern.test(graphics)).map(([brand]) => brand);

  return {
    platform: os.platform(),
    architecture: os.arch(),
    distribution: release.ID || os.platform(),
    distributionVersion: release.VERSION_ID || "unknown",
    cpuBrand: os.cpus()[0]?.model || "Unknown CPU",
    cpuCores: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1024 / 1024),
    gpuBrands,
    gpuDescription: graphics || "No GPU reported by the operating system",
    dockerAvailable: Boolean(command("docker", ["--version"])),
    systemdAvailable: Boolean(command("systemctl", ["--version"])),
  };
}

async function choose(rl, title, options, defaultIndex = 0) {
  output.write(`\n${title}\n`);
  options.forEach((option, index) => output.write(`  ${index + 1}. ${option.label}${index === defaultIndex ? " (recommended)" : ""}\n`));
  const answer = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
  const index = answer ? Number(answer) - 1 : defaultIndex;
  if (!Number.isInteger(index) || !options[index]) throw new Error("Invalid selection.");
  return options[index].value;
}

function nativeLayout() {
  return {
    root: "/opt/alertly",
    releases: "/opt/alertly/releases",
    current: "/opt/alertly/current",
    runtime: "/opt/alertly/runtime",
    config: "/opt/alertly/shared/config",
    data: "/opt/alertly/shared/data",
    uploads: "/opt/alertly/shared/uploads",
    backups: "/opt/alertly/shared/backups",
    logs: "/opt/alertly/shared/logs",
    externalFootprint: ["/etc/systemd/system/alertly.service"],
  };
}

function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o750 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
  fs.appendFileSync(historyPath, `${JSON.stringify({ at: new Date().toISOString(), schemaVersion: config.schemaVersion, revision: config.revision, choices: config.choices })}\n`, { mode: 0o640 });
}

async function main() {
  const detected = detectHost();
  if (process.argv.includes("--detect")) {
    output.write(`${JSON.stringify(detected, null, 2)}\n`);
    return;
  }

  output.write("\nAlertly guided setup\nHardware is detected locally and is not uploaded.\n");
  output.write(`\nDetected: ${detected.distribution} ${detected.distributionVersion}, ${detected.cpuBrand}, ${detected.memoryMb} MB RAM\n`);
  output.write(`Graphics: ${detected.gpuDescription}\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const profile = await choose(rl, "Installation profile", [
      { label: "Demo / current Alertly", value: "demo" },
      { label: "Organization", value: "organization" },
    ]);
    const methodOptions = [
      { label: detected.dockerAvailable ? "Docker Compose (detected)" : "Docker Compose", value: "docker" },
      { label: "Contained native Linux", value: "native" },
    ];
    if (profile === "organization") methodOptions.push({ label: "Split deployment with remote workers", value: "split" });
    const method = await choose(rl, "Installation method", methodOptions, detected.dockerAvailable ? 0 : 1);

    const accelerationOptions = [];
    if (detected.gpuBrands.includes("nvidia")) accelerationOptions.push({ label: "NVIDIA GPU", value: "nvidia" });
    if (detected.gpuBrands.includes("amd")) accelerationOptions.push({ label: "AMD GPU", value: "amd" });
    if (detected.gpuBrands.includes("intel")) accelerationOptions.push({ label: "Intel GPU", value: "intel" });
    accelerationOptions.push({ label: "CPU only", value: "cpu" });
    if (method === "split") accelerationOptions.push({ label: "Remote worker decides", value: "remote" });
    const acceleration = await choose(rl, "Media processing", accelerationOptions);

    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
    const config = {
      schemaVersion: SCHEMA_VERSION,
      revision: (previous?.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
      choices: { profile, method, acceleration },
      detected,
      services: {
        queue: { backend: "postgres", durable: true },
        storage: { backend: profile === "demo" ? "local" : "s3-compatible" },
        worker: { mode: method === "split" ? "remote" : "local", acceleration },
      },
      nativeLayout: method === "native" ? nativeLayout() : null,
      installState: "configured",
    };
    saveConfig(config);
    output.write(`\nConfiguration saved (revision ${config.revision}).\n`);
    output.write("No services were changed. Run the future apply step after reviewing the generated plan.\n");
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
});

