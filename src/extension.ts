import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PythonProcess {
  pid: string;
  port: string;
  script: string;
  command: string;
}

let statusBarItem: vscode.StatusBarItem;
let checkInterval: NodeJS.Timeout | undefined;
let knownPorts = new Set<string>();
let windowId: string;
let lockCleanupInterval: NodeJS.Timeout | undefined;
let lastUserActivity: number = Date.now();

export function activate(context: vscode.ExtensionContext) {
  windowId = generateWindowId();
  
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'debugpy.attachToPort';
  statusBarItem.tooltip = 'Click to attach to debugpy process';
  context.subscriptions.push(statusBarItem);

  // Register commands
  const attachCommand = vscode.commands.registerCommand('debugpy.attachToPort', async () => {
    markUserActivity();
    
    try {
      const pythonProcesses = await findPythonProcesses();

      if (pythonProcesses.length === 0) {
        vscode.window.showErrorMessage("No Python processes with listening ports found. Make sure a debugpy process is running.");
        return;
      }

      if (pythonProcesses.length === 1) {
        const process = pythonProcesses[0];
        
        if (!tryAcquirePortLock(process.port)) {
          vscode.window.showWarningMessage(`Port ${process.port} is already being debugged by another window.`);
          return;
        }
        
        try {
          await attachToDebugger(process);
          setTimeout(() => releasePortLock(process.port), 1000);
        } catch (error) {
          releasePortLock(process.port);
          throw error;
        }
        return;
      }

      // Multiple processes - show selection
      const quickPickItems = pythonProcesses.map((proc: PythonProcess) => ({
        label: `Port ${proc.port} - ${proc.script}`,
        description: proc.command.length > 50 ? proc.command.substring(0, 50) + '...' : proc.command,
        process: proc
      }));

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: "Choose a port to debug"
      });

      if (selected) {
        if (!tryAcquirePortLock(selected.process.port)) {
          vscode.window.showWarningMessage(`Port ${selected.process.port} is already being debugged by another window.`);
          return;
        }
        
        try {
          await attachToDebugger(selected.process);
          setTimeout(() => releasePortLock(selected.process.port), 1000);
        } catch (error) {
          releasePortLock(selected.process.port);
          throw error;
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error searching for Python processes: ${error}`);
    }
  });

  const toggleLiveMonitoringCommand = vscode.commands.registerCommand('debugpy.toggleLiveMonitoring', async () => {
    markUserActivity();
    
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('enableLiveMonitoring', true);

    await config.update('enableLiveMonitoring', !currentValue, vscode.ConfigurationTarget.Global);

    const newState = !currentValue ? 'enabled' : 'disabled';
    vscode.window.showInformationMessage(`Debugpy live monitoring ${newState}`);

    restartMonitoring();
  });

  const toggleAutoAttachCommand = vscode.commands.registerCommand('debugpy.toggleAutoAttach', async () => {
    markUserActivity();
    
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('autoAttach', false);

    await config.update('autoAttach', !currentValue, vscode.ConfigurationTarget.Global);

    const newState = !currentValue ? 'enabled' : 'disabled';
    vscode.window.showInformationMessage(`Debugpy auto-attach ${newState}`);
  });

  context.subscriptions.push(attachCommand, toggleLiveMonitoringCommand, toggleAutoAttachCommand);

  setupUserActivityTracking(context);
  startMonitoring();
  startLockCleanup();
  
  context.subscriptions.push({ 
    dispose: () => {
      stopMonitoring();
      stopLockCleanup();
      cleanupWindowLocks();
    }
  });

  const configDisposable = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('debugpyAttacher.enableLiveMonitoring')) {
      restartMonitoring();
    }
  });
  context.subscriptions.push(configDisposable);
}

function setupUserActivityTracking(context: vscode.ExtensionContext) {
  const trackingDisposables = [
    vscode.workspace.onDidChangeTextDocument(() => markUserActivity()),
    vscode.window.onDidChangeActiveTextEditor(() => markUserActivity()),
    vscode.window.onDidChangeTextEditorSelection(() => markUserActivity()),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => markUserActivity()),
    vscode.window.onDidChangeActiveTerminal(() => markUserActivity()),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        markUserActivity();
      }
    })
  ];

  context.subscriptions.push(...trackingDisposables);
}

function markUserActivity() {
  lastUserActivity = Date.now();
  updateActiveWindow();
}

function generateWindowId(): string {
  return `vscode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function getLockDir(): string {
  return path.join(os.tmpdir(), 'debugpy-attacher-locks');
}

function ensureLockDir(): void {
  const lockDir = getLockDir();
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
}

function getPortLockPath(port: string): string {
  return path.join(getLockDir(), `port-${port}.lock`);
}

function getActiveWindowPath(): string {
  return path.join(getLockDir(), 'active-window.lock');
}

function updateActiveWindow(): void {
  try {
    ensureLockDir();
    const activeWindowPath = getActiveWindowPath();
    fs.writeFileSync(activeWindowPath, JSON.stringify({
      windowId,
      timestamp: Date.now(),
      lastActivity: lastUserActivity
    }));
  } catch (error) {
    // Silently handle file system errors
  }
}

function isActiveWindow(): boolean {
  try {
    const activeWindowPath = getActiveWindowPath();
    if (!fs.existsSync(activeWindowPath)) {
      updateActiveWindow();
      return true;
    }

    const data = JSON.parse(fs.readFileSync(activeWindowPath, 'utf8'));
    
    if (lastUserActivity > data.lastActivity + 1000) {
      updateActiveWindow();
      return true;
    }
    
    if (Date.now() - data.lastActivity > 15000) {
      updateActiveWindow();
      return true;
    }

    return data.windowId === windowId;
  } catch (error) {
    updateActiveWindow();
    return true;
  }
}

function tryAcquirePortLock(port: string): boolean {
  try {
    if (!isActiveWindow()) {
      return false;
    }

    ensureLockDir();
    const lockPath = getPortLockPath(port);
    
    if (fs.existsSync(lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      
      if (Date.now() - lockData.timestamp < 30000 && lockData.windowId !== windowId) {
        return false;
      }
    }

    if (!isActiveWindow()) {
      return false;
    }

    fs.writeFileSync(lockPath, JSON.stringify({
      windowId,
      port,
      timestamp: Date.now(),
      userActivity: lastUserActivity
    }));
    
    return true;
  } catch (error) {
    return false;
  }
}

function releasePortLock(port: string): void {
  try {
    const lockPath = getPortLockPath(port);
    if (fs.existsSync(lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lockData.windowId === windowId) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (error) {
    // Silently handle errors
  }
}

function startLockCleanup(): void {
  lockCleanupInterval = setInterval(() => {
    cleanupStaleLocks();
  }, 30000);
}

function stopLockCleanup(): void {
  if (lockCleanupInterval) {
    clearInterval(lockCleanupInterval);
    lockCleanupInterval = undefined;
  }
}

function cleanupStaleLocks(): void {
  try {
    const lockDir = getLockDir();
    if (!fs.existsSync(lockDir)) return;

    const files = fs.readdirSync(lockDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(lockDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        if (now - data.timestamp > 60000) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    // Silently handle cleanup errors
  }
}

function cleanupWindowLocks(): void {
  try {
    const lockDir = getLockDir();
    if (!fs.existsSync(lockDir)) return;

    const files = fs.readdirSync(lockDir);
    
    for (const file of files) {
      const filePath = path.join(lockDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        if (data.windowId === windowId) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    // Silently handle cleanup errors
  }
}

function isLiveMonitoringEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('debugpyAttacher');
  const defaultValue = process.platform === 'win32' ? false : true;
  return config.get('enableLiveMonitoring', defaultValue);
}

function isAutoAttachEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('debugpyAttacher');
  return config.get('autoAttach', false);
}

function startMonitoring() {
  markUserActivity();
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
  knownPorts.clear();
  startMonitoring();
}

async function updateStatusBar() {
  try {
    const processes = await findPythonProcesses();
    const currentPorts = new Set(processes.map((p: PythonProcess) => p.port));

    if (processes.length > 0) {
      const ports = processes.map((p: PythonProcess) => p.port).join(', ');
      const isActive = isActiveWindow();
      
      statusBarItem.text = `$(debug) Debugpy: ${ports}`;
      statusBarItem.show();

      if (isAutoAttachEnabled() && isActive) {
        const newPorts = processes.filter((p: PythonProcess) => !knownPorts.has(p.port));
        
        for (const process of newPorts) {
          if (!vscode.debug.activeDebugSession && 
              isActiveWindow() && 
              tryAcquirePortLock(process.port)) {
            
            if (!isActiveWindow()) {
              releasePortLock(process.port);
              continue;
            }
            
            try {
              await attachToDebugger(process, true);
              vscode.window.showInformationMessage(`Auto-attached to debugpy on port ${process.port}`);
              
              setTimeout(() => releasePortLock(process.port), 5000);
            } catch (error) {
              if (isActiveWindow()) {
                vscode.window.showWarningMessage(`Failed to auto-attach to port ${process.port}: ${error}`);
              }
              releasePortLock(process.port);
            }
          }
        }
      }
    } else {
      statusBarItem.hide();
    }

    knownPorts = currentPorts;
  } catch (error) {
    statusBarItem.hide();
  }
}

async function findPythonProcesses(): Promise<PythonProcess[]> {
  return new Promise((resolve) => {
    const processes: PythonProcess[] = [];
    const seenPorts = new Set<string>();

    const platformCmd = process.platform === 'win32'
      ? `wmic process where "commandline like '%debugpy%'" get ProcessId,CommandLine /format:csv`
      : `ps -eo pid,args | grep python | grep debugpy | grep -v grep`;
    
    exec(platformCmd, { 
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }, (err, output, stderr) => {
      if (err || !output || !output.trim()) {
        resolve([]);
        return;
      }

      const lines = output.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (process.platform === 'win32') {
          const parts = line.split(',');
          if (parts.length >= 3 && parts[1] && parts[1].includes('debugpy')) {
            const commandLine = parts[1];
            const pid = parts[2] ? parts[2].trim() : '';
            
            let port = null;
            const portMatches = [
              commandLine.match(/--port\s+(\d+)/),
              commandLine.match(/--listen\s+(\d+)/),
              commandLine.match(/:(\d{4,5})/),
              commandLine.match(/\b(5\d{3}|6\d{3}|7\d{3}|8\d{3}|9\d{3})\b/)
            ];
            
            for (const match of portMatches) {
              if (match) {
                port = match[1];
                break;
              }
            }
            
            if (port && /^\d+$/.test(pid) && !seenPorts.has(port)) {
              seenPorts.add(port);
              
              const scriptMatch = commandLine.match(/([^\\\/\s]+\.py)/);
              const script = scriptMatch ? scriptMatch[1] : 'Unknown';
              
              processes.push({ pid, port, script, command: commandLine });
            }
          }
        } else {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;

          const pid = parts[0];
          const command = parts.slice(1).join(' ');

          const portMatch = command.match(/--port\s+(\d+)/);
          if (portMatch && !seenPorts.has(portMatch[1])) {
            seenPorts.add(portMatch[1]);

            const scriptMatch = command.match(/([^\/\s]+\.py)/);
            const script = scriptMatch ? scriptMatch[1] : 'Unknown script';

            processes.push({ pid, port: portMatch[1], script, command });
          }
        }
      }
      
      resolve(processes);
    });
  });
}

async function attachToDebugger(process: PythonProcess, isAutoAttach: boolean = false): Promise<void> {
  if (!isActiveWindow()) {
    throw new Error('Window is not active');
  }

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
      if (!isAutoAttach && isActiveWindow()) {
        vscode.window.showInformationMessage(`Debugger attached to port ${process.port}`);
      }
    } else {
      throw new Error('Debug session failed to start');
    }
  } catch (error) {
    if (isActiveWindow()) {
      vscode.window.showErrorMessage(`Error attaching debugger: ${error}`);
    }
    throw error;
  }
}

export function deactivate() {
  stopMonitoring();
  stopLockCleanup();
  cleanupWindowLocks();
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
