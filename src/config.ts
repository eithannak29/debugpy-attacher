import * as vscode from 'vscode';

export class ConfigManager {
  private static instance: ConfigManager;
  
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  getDefaultPort(): number {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    return config.get('defaultPort', 5678);
  }

  getDefaultHost(): string {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    return config.get('defaultHost', 'localhost');
  }

  isLiveMonitoringEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const defaultValue = process.platform === 'win32' ? false : true;
    return config.get('enableLiveMonitoring', defaultValue);
  }

  isAutoAttachEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    return config.get('autoAttach', false);
  }

  isRulerDecorationsEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    return config.get('showRulerDecorations', true);
  }

  async toggleLiveMonitoring(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('enableLiveMonitoring', true);
    
    await config.update('enableLiveMonitoring', !currentValue, vscode.ConfigurationTarget.Global);
    return !currentValue;
  }

  async toggleAutoAttach(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('debugpyAttacher');
    const currentValue = config.get('autoAttach', false);
    
    await config.update('autoAttach', !currentValue, vscode.ConfigurationTarget.Global);
    return !currentValue;
  }
}
