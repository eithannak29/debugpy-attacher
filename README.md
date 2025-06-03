# DebugPy Attacher

Automatically detect and attach to debugpy processes in VS Code.

![Demo](debug-attach.gif)

## Quick Start

1. **Add debugpy to your Python code**: Type `debugpy` and press Tab to insert:

   ```python
   import debugpy; (debugpy.listen(5678), debugpy.wait_for_client()) if not debugpy.is_client_connected() else None
   ```

2. **Set breakpoints**: You can add breakpoints by clicking in the left margin of your code, just like using VS Code's built-in debugger

3. **Run your Python program**: You can run your Python process however you want - from terminal, command line, IDE, or any other method

4. **Attach the debugger** (choose one):
   - **Auto-Attach (Beta)**: Enable auto-attach to automatically connect when new debugpy processes are detected
   - **Auto**: Click the status bar item (bottom right) when live monitoring is active
   - **Manual**: Press `Cmd+Shift+P` → "Debugpy: Attach to Process"


## Commands

- `Debugpy: Attach to Process` - Attach to debugpy process
- `Debugpy: Toggle Live Monitoring` - Enable/disable auto-detection
- `Debugpy: Toggle Auto-Attach` - Enable/disable automatic attachment to new processes

## Requirements

- Python with debugpy installed
- macOS/Linux
