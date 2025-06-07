import * as vscode from 'vscode';
import { ConfigManager } from './config';

export class DecorationManager {
  private decorationType: vscode.TextEditorDecorationType;
  private config: ConfigManager;

  constructor() {
    this.config = ConfigManager.getInstance();
    this.decorationType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(255,20,147, 0.5)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
  }

  updateDecorations(editor: vscode.TextEditor): void {
    if (!this.config.isRulerDecorationsEnabled()) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const decorations: vscode.DecorationOptions[] = [];

    for (const range of editor.visibleRanges) {
      for (let i = range.start.line; i <= range.end.line; i++) {
        const line = editor.document.lineAt(i);
        if (line.text.includes('# region dbpy_attach')) {
          let endLine = this.findRegionEnd(editor.document, i);
          
          const regionRange = new vscode.Range(
            new vscode.Position(i, 0),
            new vscode.Position(i, line.text.length)
          );
          decorations.push({ 
            range: regionRange,
            hoverMessage: 'DebugPy Attach Region'
          });
          
          i = endLine;
        }
      }
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  async collapseSpecificRegion(editor: vscode.TextEditor, insertPosition: vscode.Position): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 25));
    
    const originalSelection = editor.selection;
    const document = editor.document;
    
    // Find the region that contains or is near the insert position
    for (let i = Math.max(0, insertPosition.line - 0); i < Math.min(document.lineCount, insertPosition.line + 1); i++) {
      const line = document.lineAt(i);
      if (line.text.includes('# region dbpy_attach')) {
        const endLine = this.findRegionEnd(document, i);
        
        if (endLine < document.lineCount) {
          const foldRange = new vscode.Range(
            new vscode.Position(i, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
          );
          
          await vscode.commands.executeCommand('editor.fold', {
            ranges: [foldRange],
            selectionLines: [foldRange.start.line]
          });
          
          setTimeout(() => {
            editor.selection = originalSelection;
          }, 10);
          
          return;
        }
      }
    }
  }

  createFoldingRangeProvider(): vscode.FoldingRangeProvider {
    return {
      provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const foldingRanges: vscode.FoldingRange[] = [];
        
        for (let i = 0; i < document.lineCount; i++) {
          const line = document.lineAt(i);
          if (line.text.includes('# region dbpy_attach')) {
            let endLine = i + 1;
            while (endLine < document.lineCount) {
              const currentLine = document.lineAt(endLine);
              if (currentLine.text.includes('# endregion')) {
                break;
              }
              endLine++;
            }
            
            if (endLine < document.lineCount) {
              foldingRanges.push(new vscode.FoldingRange(i, endLine, vscode.FoldingRangeKind.Region));
            }
            
            i = endLine;
          }
        }
        
        return foldingRanges;
      }
    };
  }

  setupEventHandlers(context: vscode.ExtensionContext): void {
    const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (editor && editor.document.languageId === 'python') {
        this.updateDecorations(editor);
      }
    });

    const textChangeDisposable = vscode.workspace.onDidChangeTextDocument(async event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document && editor.document.languageId === 'python') {
        this.updateDecorations(editor);
      }
    });

    const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument(async document => {
      if (document.languageId === 'python') {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
          this.updateDecorations(editor);
        }
      }
    });

    // Initialize decorations for already open editor
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'python') {
      const editor = vscode.window.activeTextEditor;
      this.updateDecorations(editor);
    }

    context.subscriptions.push(
      activeEditorDisposable, 
      textChangeDisposable, 
      documentOpenDisposable
    );
  }

  private findRegionEnd(document: vscode.TextDocument, startLine: number): number {
    let endLine = startLine + 1;
    while (endLine < document.lineCount) {
      const currentLine = document.lineAt(endLine);
      if (currentLine.text.includes('# endregion')) {
        break;
      }
      endLine++;
    }
    return endLine;
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
