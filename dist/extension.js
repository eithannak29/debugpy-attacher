"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var import_child_process = require("child_process");
var statusBarItem;
var checkInterval;
function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "debugpy.attachToPort";
  statusBarItem.tooltip = "Click to attach to debugpy process";
  context.subscriptions.push(statusBarItem);
  const disposable = vscode.commands.registerCommand("debugpy.attachToPort", async () => {
    try {
      const pythonProcesses = await findPythonProcesses();
      if (pythonProcesses.length === 0) {
        vscode.window.showErrorMessage("No Python processes with listening ports found. Make sure a debugpy process is running.");
        return;
      }
      if (pythonProcesses.length === 1) {
        await attachToDebugger(pythonProcesses[0]);
        return;
      }
      const quickPickItems = pythonProcesses.map((proc) => ({
        label: proc.port,
        process: proc
      }));
      const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: "Choose a port to debug"
      });
      if (selected) {
        await attachToDebugger(selected.process);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error searching for Python processes: ${error}`);
    }
  });
  const toggleLiveMonitoringCommand = vscode.commands.registerCommand("debugpy.toggleLiveMonitoring", async () => {
    const config = vscode.workspace.getConfiguration("debugpyAttacher");
    const currentValue = config.get("enableLiveMonitoring", true);
    await config.update("enableLiveMonitoring", !currentValue, vscode.ConfigurationTarget.Global);
    const newState = !currentValue ? "enabled" : "disabled";
    vscode.window.showInformationMessage(`Debugpy live monitoring ${newState}`);
    restartMonitoring();
  });
  context.subscriptions.push(disposable);
  context.subscriptions.push(toggleLiveMonitoringCommand);
  startMonitoring();
  context.subscriptions.push({ dispose: () => stopMonitoring() });
  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("debugpyAttacher.enableLiveMonitoring")) {
      restartMonitoring();
    }
  });
  context.subscriptions.push(configDisposable);
}
function isLiveMonitoringEnabled() {
  const config = vscode.workspace.getConfiguration("debugpyAttacher");
  return config.get("enableLiveMonitoring", true);
}
function startMonitoring() {
  updateStatusBar();
  if (isLiveMonitoringEnabled()) {
    checkInterval = setInterval(updateStatusBar, 3e3);
  }
}
function stopMonitoring() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = void 0;
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
      const ports = processes.map((p) => p.port).join(", ");
      statusBarItem.text = `$(debug) Debugpy: ${ports}`;
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  } catch (error) {
    statusBarItem.hide();
  }
}
async function findPythonProcesses() {
  return new Promise((resolve) => {
    (0, import_child_process.exec)("ps -eo pid,args | grep python | grep debugpy | grep -v grep", (err, output) => {
      if (err || !output.trim()) {
        resolve([]);
        return;
      }
      const processes = [];
      const seenPorts = /* @__PURE__ */ new Set();
      const lines = output.split("\n").filter((line) => line.trim());
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parts[0];
        const command = parts.slice(1).join(" ");
        const portMatch = command.match(/--port\s+(\d+)/);
        if (portMatch && !seenPorts.has(portMatch[1])) {
          seenPorts.add(portMatch[1]);
          let script = "Unknown script";
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
    const success = await vscode.debug.startDebugging(void 0, {
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
    } else {
      vscode.window.showErrorMessage(`Failed to attach to port ${process.port}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Error attaching debugger: ${error}`);
  }
}
function deactivate() {
  stopMonitoring();
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
