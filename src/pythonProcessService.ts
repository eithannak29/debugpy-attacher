import { exec } from 'child_process';

export interface PythonProcess {
  pid: string;
  port: string;
  script: string;
  command: string;
}

export class PythonProcessService {
  async findPythonProcesses(): Promise<PythonProcess[]> {
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
          const process = this.parseProcessLine(line, seenPorts);
          if (process) {
            processes.push(process);
          }
        }

        resolve(processes);
      });
    });
  }

  private parseProcessLine(line: string, seenPorts: Set<string>): PythonProcess | null {
    if (process.platform === 'win32') {
      return this.parseWindowsProcess(line, seenPorts);
    } else {
      return this.parseUnixProcess(line, seenPorts);
    }
  }

  private parseWindowsProcess(line: string, seenPorts: Set<string>): PythonProcess | null {
    const parts = line.split(',');
    if (parts.length >= 3 && parts[1] && parts[1].includes('debugpy')) {
      const commandLine = parts[1];
      const pid = parts[2] ? parts[2].trim() : '';

      const port = this.extractPort(commandLine);

      if (port && /^\d+$/.test(pid) && !seenPorts.has(port)) {
        seenPorts.add(port);

        const scriptMatch = commandLine.match(/([^\\\/\s]+\.py)/);
        const script = scriptMatch ? scriptMatch[1] : 'Unknown';

        return { pid, port, script, command: commandLine };
      }
    }
    return null;
  }

  private parseUnixProcess(line: string, seenPorts: Set<string>): PythonProcess | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return null;

    const pid = parts[0];
    const command = parts.slice(1).join(' ');

    const portMatch = command.match(/--port\s+(\d+)/);
    if (portMatch && !seenPorts.has(portMatch[1])) {
      seenPorts.add(portMatch[1]);

      const scriptMatch = command.match(/([^\/\s]+\.py)/);
      const script = scriptMatch ? scriptMatch[1] : 'Unknown script';

      return { pid, port: portMatch[1], script, command };
    }
    return null;
  }

  private extractPort(commandLine: string): string | null {
    const portMatches = [
      commandLine.match(/--port\s+(\d+)/),
      commandLine.match(/--listen\s+(\d+)/),
      commandLine.match(/:(\d{4,5})/),
      commandLine.match(/\b(5\d{3}|6\d{3}|7\d{3}|8\d{3}|9\d{3})\b/)
    ];

    for (const match of portMatches) {
      if (match) {
        return match[1];
      }
    }
    return null;
  }
}
