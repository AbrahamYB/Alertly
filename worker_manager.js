import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const automationPath = path.join(__dirname, 'automation.js');

let currentChild = null;

function startAutomation() {
    console.log('[Master] Starting background automation process...');
    currentChild = fork(automationPath);

    currentChild.on('exit', (code) => {
        console.log(`[Master] Automation process exited with code ${code}. Restarting in 10s...`);
        currentChild = null;
        setTimeout(startAutomation, 10000);
    });

    currentChild.on('error', (err) => {
        console.error('[Master] Automation process error:', err);
    });
}

// If this file is run directly, start the automation
if (process.argv[1] === __filename) {
    startAutomation();
}

export { startAutomation };
