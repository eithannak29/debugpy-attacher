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
let knownPorts = new Set<string>(); // Track known ports to detect new ones
let windowId: string; // Unique identifier for this window
let lockCleanupInterval: NodeJS.Timeout | undefined;
let lastUserActivity: number = Date.now(); // Track last user activity in this window

export function activate(context: vscode.ExtensionContext) {
  // Generate unique window ID
  windowId = generateWindowId();
  
  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'debugpy.attachToPort';
  statusBarItem.tooltip = 'Click to attach to debugpy process';
  context.subscriptions.push(statusBarItem);

  // Register the attach command
  const disposable = vscode.commands.registerCommand('debugpy.attachToPort', async () => {
    // Mark this window as active when user manually triggers attach
    markUserActivity();
    
    try {
      const pythonProcesses = await findPythonProcesses();

      if (pythonProcesses.length === 0) {
        vscode.window.showErrorMessage("No Python processes with listening ports found. Make sure a debugpy process is running.");
        return;
      }

      // If only one process, check if we can attach (respect locks for manual attach too)
      if (pythonProcesses.length === 1) {
        const process = pythonProcesses[0];
        
        // Check if port is already locked by another window
        if (!tryAcquirePortLock(process.port)) {
          vscode.window.showWarningMessage(`Port ${process.port} is already being debugged by another window.`);
          return;
        }
        
        try {
          await attachToDebugger(process);
          // Release lock after successful attach since manual attach is one-time
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
        // Check if port is already locked by another window
        if (!tryAcquirePortLock(selected.process.port)) {
          vscode.window.showWarningMessage(`Port ${selected.process.port} is already being debugged by another window.`);
          return;
        }
        
        try {
          await attachToDebugger(selected.process);
          // Release lock after successful attach since manual attach is one-time
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

  // Register the toggle live monitoring command
  const toggleLiveMonitoringCommand = vscode.commands.registerCommand('debugpy.toggleLiveMonitoring', async () => {
    markUserActivity(); // Mark activity when user interacts
    
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('enableLiveMonitoring', true);

    await config.update('enableLiveMonitoring', !currentValue, vscode.ConfigurationTarget.Global);

    const newState = !currentValue ? 'enabled' : 'disabled';
    vscode.window.showInformationMessage(`Debugpy live monitoring ${newState}`);

    // Restart monitoring with new setting
    restartMonitoring();
  });

  // Register the toggle auto-attach command
  const toggleAutoAttachCommand = vscode.commands.registerCommand('debugpy.toggleAutoAttach', async () => {
    markUserActivity(); // Mark activity when user interacts
    
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('autoAttach', false);

    await config.update('autoAttach', !currentValue, vscode.ConfigurationTarget.Global);

    const newState = !currentValue ? 'enabled' : 'disabled';
    vscode.window.showInformationMessage(`Debugpy auto-attach ${newState}`);
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(toggleLiveMonitoringCommand);
  context.subscriptions.push(toggleAutoAttachCommand);

  // Track user activity in this window
  setupUserActivityTracking(context);

  // Start monitoring based on configuration
  startMonitoring();
  
  // Start lock cleanup interval
  startLockCleanup();
  
  context.subscriptions.push({ 
    dispose: () => {
      stopMonitoring();
      stopLockCleanup();
      cleanupWindowLocks();
    }
  });

  // Listen for configuration changes
  const configDisposable = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('debugpyAttacher.enableLiveMonitoring')) {
      restartMonitoring();
    }
  });
  context.subscriptions.push(configDisposable);
}

function setupUserActivityTracking(context: vscode.ExtensionContext) {
  // Track various user activities to determine the active window
  
  // Text document changes
  const onDocumentChange = vscode.workspace.onDidChangeTextDocument(() => {
    markUserActivity();
  });
  
  // Active editor changes
  const onEditorChange = vscode.window.onDidChangeActiveTextEditor(() => {
    markUserActivity();
  });
  
  // Selection changes
  const onSelectionChange = vscode.window.onDidChangeTextEditorSelection(() => {
    markUserActivity();
  });
  
  // Visible ranges changes (scrolling, etc.)
  const onVisibleRangesChange = vscode.window.onDidChangeTextEditorVisibleRanges(() => {
    markUserActivity();
  });
  
  // Terminal activity
  const onTerminalChange = vscode.window.onDidChangeActiveTerminal(() => {
    markUserActivity();
  });
  
  // Window state changes
  const onWindowStateChange = vscode.window.onDidChangeWindowState(state => {
    if (state.focused) {
      markUserActivity();
    }
  });

  // Status bar item clicks
  statusBarItem.command = 'debugpy.attachToPort';

  context.subscriptions.push(
    onDocumentChange,
    onEditorChange,
    onSelectionChange,
    onVisibleRangesChange,
    onTerminalChange,
    onWindowStateChange
  );
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
    console.error('Failed to update active window:', error);
  }
}

function isActiveWindow(): boolean {
  try {
    const activeWindowPath = getActiveWindowPath();
    if (!fs.existsSync(activeWindowPath)) {
      // No active window recorded, this window can be active
      updateActiveWindow();
      return true;
    }

    const data = JSON.parse(fs.readFileSync(activeWindowPath, 'utf8'));
    
    // Check if this window has more recent activity (with a small buffer)
    if (lastUserActivity > data.lastActivity + 1000) { // 1 second buffer
      updateActiveWindow();
      return true;
    }
    
    // Check if the recorded active window is stale (reduced to 15 seconds)
    if (Date.now() - data.lastActivity > 15000) {
      updateActiveWindow();
      return true;
    }

    // This window is active if it's the recorded active window
    return data.windowId === windowId;
  } catch (error) {
    // If there's an error reading the file, assume this window can be active
    updateActiveWindow();
    return true;
  }
}

function tryAcquirePortLock(port: string): boolean {
  try {
    // First check: are we the active window?
    if (!isActiveWindow()) {
      return false;
    }

    ensureLockDir();
    const lockPath = getPortLockPath(port);
    
    // Check if lock already exists and is recent
    if (fs.existsSync(lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      
      // If lock is less than 30 seconds old and from different window, don't acquire
      if (Date.now() - lockData.timestamp < 30000 && lockData.windowId !== windowId) {
        return false;
      }
    }

    // Final check: are we still the active window?
    if (!isActiveWindow()) {
      return false;
    }

    // Acquire the lock
    fs.writeFileSync(lockPath, JSON.stringify({
      windowId,
      port,
      timestamp: Date.now(),
      userActivity: lastUserActivity
    }));
    
    return true;
  } catch (error) {
    console.error('Failed to acquire port lock:', error);
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
    console.error('Failed to release port lock:', error);
  }
}

function startLockCleanup(): void {
  // Clean up stale locks every 30 seconds
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
        
        // Remove locks older than 60 seconds
        if (now - data.timestamp > 60000) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        // If we can't read the file, it might be corrupted, remove it
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup stale locks:', error);
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
        
        // Remove locks from this window
        if (data.windowId === windowId) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        // Ignore errors when cleaning up
      }
    }
  } catch (error) {
    console.error('Failed to cleanup window locks:', error);
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
  // Mark initial activity
  markUserActivity();
  
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
  knownPorts.clear(); // Reset known ports when restarting
  startMonitoring();
}

async function updateStatusBar() {
  try {
    const processes = await findPythonProcesses();
    const currentPorts = new Set(processes.map((p: PythonProcess) => p.port));

    if (processes.length > 0) {
      const ports = processes.map((p: PythonProcess) => p.port).join(', ');
      const isActive = isActiveWindow();
      
      // Show different status based on whether this is the active window
      statusBarItem.text = `$(debug) Debugpy: ${ports}`;
      statusBarItem.show();

      // ONLY auto-attach for the active window - completely skip for others
      if (isAutoAttachEnabled() && isActive) {
        const newPorts = processes.filter((p: PythonProcess) => !knownPorts.has(p.port));
        
        for (const process of newPorts) {
          // Multiple safety checks before attempting attach
          if (!vscode.debug.activeDebugSession && 
              isActiveWindow() && // Double-check we're still active
              tryAcquirePortLock(process.port)) {
            
            // Triple-check we're still the active window before actual attach
            if (!isActiveWindow()) {
              releasePortLock(process.port);
              continue;
            }
            
            try {
              await attachToDebugger(process, true); // Pass true for auto-attach
              vscode.window.showInformationMessage(`Auto-attached to debugpy on port ${process.port}`);
              
              // Keep the lock for a bit longer to prevent other windows from trying
              setTimeout(() => releasePortLock(process.port), 5000);
            } catch (error) {
              // Silently handle errors from non-active windows
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

    // Update known ports for all windows to keep them in sync
    knownPorts = currentPorts;
  } catch (error) {
    statusBarItem.hide();
  }
}

async function findPythonProcesses(): Promise<PythonProcess[]> {
  return new Promise((resolve) => {
    // Just find all debugpy processes directly
    exec("ps -eo pid,args | grep python | grep debugpy | grep -v grep", (err, output) => {
      if (err || !output.trim()) {
        resolve([]);
        return;
      }

      const processes: PythonProcess[] = [];
      const seenPorts = new Set<string>();
      const lines = output.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;

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

async function attachToDebugger(process: PythonProcess, isAutoAttach: boolean = false): Promise<void> {
  // Final safety check - don't attempt attach if not active window
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
      // Only show success message for manual attach and if we're still the active window
      if (!isAutoAttach && isActiveWindow()) {
        vscode.window.showInformationMessage(`Debugger attached to port ${process.port}`);
      }
    } else {
      throw new Error('Debug session failed to start');
    }
  } catch (error) {
    // Only show error messages if we're the active window
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
