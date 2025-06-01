"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
let statusBarItem;
let checkInterval;
function activate(context) {
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'debugpy.attachToPort';
    statusBarItem.tooltip = 'Click to attach to debugpy process';
    context.subscriptions.push(statusBarItem);
    // Register the attach command
    const disposable = vscode.commands.registerCommand('debugpy.attachToPort', async () => {
        try {
            const pythonProcesses = await findPythonProcesses();
            if (pythonProcesses.length === 0) {
                vscode.window.showErrorMessage("No Python processes with listening ports found. Make sure a debugpy process is running.");
                return;
            }
            // If only one process, attach directly
            if (pythonProcesses.length === 1) {
                await attachToDebugger(pythonProcesses[0]);
                return;
            }
            // Multiple processes - show selection
            const quickPickItems = pythonProcesses.map(proc => ({
                label: proc.port,
                process: proc
            }));
            const selected = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: "Choose a port to debug"
            });
            if (selected) {
                await attachToDebugger(selected.process);
            }
        }
        catch (error) {
            vscode.window.showErrorMessage(`Error searching for Python processes: ${error}`);
        }
    });
    // Register the toggle live monitoring command
    const toggleLiveMonitoringCommand = vscode.commands.registerCommand('debugpy.toggleLiveMonitoring', async () => {
        const config = vscode.workspace.getConfiguration('debugpyAttacher');
        const currentValue = config.get('enableLiveMonitoring', true);
        await config.update('enableLiveMonitoring', !currentValue, vscode.ConfigurationTarget.Global);
        const newState = !currentValue ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Debugpy live monitoring ${newState}`);
        // Restart monitoring with new setting
        restartMonitoring();
    });
    context.subscriptions.push(disposable);
    context.subscriptions.push(toggleLiveMonitoringCommand);
    // Start monitoring based on configuration
    startMonitoring();
    context.subscriptions.push({ dispose: () => stopMonitoring() });
    // Listen for configuration changes
    const configDisposable = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('debugpyAttacher.enableLiveMonitoring')) {
            restartMonitoring();
        }
    });
    context.subscriptions.push(configDisposable);
}
function isLiveMonitoringEnabled() {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    return config.get('enableLiveMonitoring', true);
}
function startMonitoring() {
    // Check immediately
    updateStatusBar();
    if (isLiveMonitoringEnabled()) {
        checkInterval = setInterval(updateStatusBar, 3000);
    }
}
function stopMonitoring() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = undefined;
    }
}
function restartMonitoring() {
    stopMonitoring();
    startMonitoring();
}
async function updateStatusBar() {
    try {
        const processes = await findPythonProcesses();
        if (processes.length > 0) {
            const ports = processes.map(p => p.port).join(', ');
            statusBarItem.text = `$(debug) Debugpy: ${ports}`;
            statusBarItem.show();
        }
        else {
            statusBarItem.hide();
        }
    }
    catch (error) {
        statusBarItem.hide();
    }
}
async function findPythonProcesses() {
    return new Promise((resolve) => {
        // Just find all debugpy processes directly
        (0, child_process_1.exec)("ps -eo pid,args | grep python | grep debugpy | grep -v grep", (err, output) => {
            if (err || !output.trim()) {
                resolve([]);
                return;
            }
            const processes = [];
            const seenPorts = new Set();
            const lines = output.split('\n').filter(line => line.trim());
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 2)
                    continue;
                const pid = parts[0];
                const command = parts.slice(1).join(' ');
                // Extract debugpy port
                const portMatch = command.match(/--port\s+(\d+)/);
                if (portMatch && !seenPorts.has(portMatch[1])) {
                    seenPorts.add(portMatch[1]);
                    // Extract script name (simplified)
                    let script = 'Unknown script';
                    const scriptMatch = command.match(/([^\/\s]+\.py)/);
                    if (scriptMatch) {
                        script = scriptMatch[1];
                    }
                    processes.push({
                        pid,
                        port: portMatch[1],
                        script,
                        command
                    });
                }
            }
            resolve(processes);
        });
    });
}
async function attachToDebugger(process) {
    try {
        const success = await vscode.debug.startDebugging(undefined, {
            name: `Attach to ${process.script}`,
            type: "python",
            request: "attach",
            connect: {
                host: "localhost",
                port: parseInt(process.port)
            },
            justMyCode: false,
            console: "integratedTerminal"
        });
        if (success) {
            vscode.window.showInformationMessage(`Debugger attached to port ${process.port}`);
        }
        else {
            vscode.window.showErrorMessage(`Failed to attach to port ${process.port}`);
        }
    }
    catch (error) {
        vscode.window.showErrorMessage(`Error attaching debugger: ${error}`);
    }
}
function deactivate() {
    stopMonitoring();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
//# sourceMappingURL=extension.js.map