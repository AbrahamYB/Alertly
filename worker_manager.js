import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const automationPath = path.join(__dirname, 'automation.js');

let currentChild = null;
let restartTimer = null;
let shuttingDown = false;

function startAutomation() {
  if (currentChild || shuttingDown) return currentChild;
  console.log("[Master] Starting background automation process...");
  currentChild = fork(automationPath);

  currentChild.on("exit", (code) => {
    currentChild = null;
    if (shuttingDown) return;
    console.log(`[Master] Automation process exited with code ${code}. Restarting in 10s...`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startAutomation();
    }, 10000);
  });

  currentChild.on("error", (err) => {
    console.error("[Master] Automation process error:", err);
  });
  return currentChild;
}

function stopAutomation() {
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (currentChild) {
    currentChild.kill("SIGTERM");
    currentChild = null;
  }
}

if (process.argv[1] === __filename) {
  startAutomation();
}

export { startAutomation, stopAutomation };
