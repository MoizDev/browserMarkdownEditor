import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useFileSystem } from './context/FileSystemContext.jsx';
import { HELP_DOC_CONTENT } from './utils/helpDoc.js';
import './index.css';
import FileExplorer from './components/FileExplorer.jsx';
import EditorPane from './components/EditorPane.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { Settings, HelpCircle } from './components/icons.jsx';

export default function App() {
  const {
    rootHandle,
    fileTree,
    isLoading,
    previousVault,
    pickDirectory,
    readFile,
    writeFile,
    createFile,
    createFolder,
    restoreVault,
    moveToTrash,
    moveFile,
    renameFile,
  } = useFileSystem();

  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [saveStatus, setSaveStatus] = useState('');

  // Editor mode ('edit' or 'read')
  const [editorMode, setEditorMode] = useState('read');

  // The global light/dark theme state
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  // Font size and padding settings (persisted via localStorage)
  const [editorFontSize, setEditorFontSize] = useState(() => parseInt(localStorage.getItem('editorFontSize') || '16', 10));
  const [treeFontSize, setTreeFontSize] = useState(() => parseInt(localStorage.getItem('treeFontSize') || '13', 10));
  const [editorPadding, setEditorPadding] = useState(() => parseInt(localStorage.getItem('editorPadding') || '6', 10));
  const [showSettings, setShowSettings] = useState(false);

  // Keep HTML root data attribute in sync with state for global CSS variables
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Sync font sizes to CSS variables and localStorage
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-normal', editorFontSize + 'px');
    localStorage.setItem('editorFontSize', editorFontSize);
  }, [editorFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--nav-item-size', treeFontSize + 'px');
    localStorage.setItem('treeFontSize', treeFontSize);
  }, [treeFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty('--editor-padding', editorPadding + '%');
    localStorage.setItem('editorPadding', editorPadding);
  }, [editorPadding]);

  const handleResetDefaults = useCallback((defaults) => {
    setEditorFontSize(defaults.editorFontSize);
    setTreeFontSize(defaults.treeFontSize);
    setEditorPadding(defaults.editorPadding);
  }, []);

  // Expanded folder paths (persisted via localStorage)
  const [expandedPaths, setExpandedPaths] = useState(() => {
    try {
      const stored = localStorage.getItem('expandedPaths');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const handleToggleExpand = useCallback((path) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem('expandedPaths', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Refs for debounced auto-save (avoid stale closures)
  const fileContentRef = useRef(fileContent);
  const activeFileRef = useRef(activeFile);
  useEffect(() => { fileContentRef.current = fileContent; }, [fileContent]);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Persist the active file path to localStorage
  useEffect(() => {
    if (activeFile?.path) {
      localStorage.setItem('lastFilePath', activeFile.path);
    }
  }, [activeFile]);

  // Sidebar resizing
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const isResizing = useRef(false);
  const hasRestoredFile = useRef(false);

  const handleFileClick = useCallback(async (node) => {
    try {
      const lowerName = node.name.toLowerCase();
      if (lowerName.endsWith('.pdf') ||
        lowerName.endsWith('.jpg') ||
        lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png')) {
        const file = await node.handle.getFile();
        const url = URL.createObjectURL(file);
        window.open(url, '_blank');
        return;
      }

      const content = await readFile(node.handle);
      setActiveFile(node);
      setFileContent(content);
      setSaveStatus('');
      setEditorMode('read');
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }, [readFile]);

  // Auto-restore the last opened file when the file tree loads
  useEffect(() => {
    if (hasRestoredFile.current || !fileTree || fileTree.length === 0) return;
    const lastPath = localStorage.getItem('lastFilePath');
    if (!lastPath) return;

    // Walk the tree to find the node matching lastPath
    const findNode = (nodes) => {
      for (const node of nodes) {
        if (node.kind === 'file' && node.path === lastPath) return node;
        if (node.children) {
          const found = findNode(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNode(fileTree);
    if (node) {
      hasRestoredFile.current = true;
      handleFileClick(node);
    }
  }, [fileTree, handleFileClick]);

  const handleHelpClick = useCallback(() => {
    setActiveFile({ name: 'Help Guide', isHelp: true, path: 'help-guide' });
    setFileContent(HELP_DOC_CONTENT);
    setEditorMode('read');
    setSaveStatus('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeFile || activeFile.isHelp) return;
    try {
      await writeFile(activeFile.handle, fileContent);
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (err) {
      console.error('Failed to save:', err);
      setSaveStatus('Error saving');
    }
  }, [activeFile, fileContent, writeFile]);

  const handleCreateFile = useCallback(async (parentHandle, name) => {
    try {
      const newFileHandle = await createFile(parentHandle, name);
      // Auto-open the newly created file and switch to edit mode
      if (newFileHandle) {
        const newNode = {
          name: name,
          handle: newFileHandle,
          parentHandle: parentHandle,
          kind: 'file',
          path: parentHandle ? `${parentHandle.name}/${name}` : name
        };
        await handleFileClick(newNode);
        setEditorMode('edit');
      }
    } catch (err) {
      console.error('Failed to create file:', err);
    }
  }, [createFile, handleFileClick]);

  const handleCreateFolder = useCallback(async (parentHandle, name) => {
    try {
      await createFolder(parentHandle, name);
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  }, [createFolder]);

  const handleTrash = useCallback(async (node) => {
    if (confirm(`Move "${node.name}" to Trash?`)) {
      const moved = await moveToTrash(node);
      if (moved && activeFileRef.current?.path === node.path) {
        // If we deleted the file we are currently looking at, clear the editor
        setActiveFile(null);
        setFileContent('');
        setSaveStatus('');
      }
    }
  }, [moveToTrash]);

  const handleRenameFile = useCallback(async (node, newName) => {
    const success = await renameFile(node, newName);
    if (success && activeFileRef.current?.path === node.path) {
      // Create a duplicate node with the new properties so the editor stays active
      const originalPathSegments = node.path.split('/');
      originalPathSegments.pop(); // Remove old name
      originalPathSegments.push(newName); // Add new name
      const newPath = originalPathSegments.join('/');

      try {
        const fileHandle = await node.parentHandle.getFileHandle(newName);
        const renamedNode = {
          ...node,
          name: newName,
          path: newPath,
          handle: fileHandle,
        };
        setActiveFile(renamedNode);
        // Force an immediate localStorage update to avoid race conditions on save
        localStorage.setItem('lastFilePath', renamedNode.path);
      } catch (err) {
        console.error('Could not get handle for renamed active file', err);
      }
    }
  }, [renameFile]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      // Cmd+N — create new note in vault root
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (rootHandle) {
          const name = prompt('New note name (e.g. "note.md"):');
          if (name) handleCreateFile(rootHandle, name);
        }
      }
      // Cmd+E — toggle read/edit mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        if (!activeFileRef.current?.isHelp) {
          setEditorMode(prev => prev === 'edit' ? 'read' : 'edit');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, rootHandle, handleCreateFile, setEditorMode]);

  // Debounced auto-save (1 second after last keystroke)
  useEffect(() => {
    if (!activeFile || activeFile.isHelp) return;
    const timer = setTimeout(async () => {
      const file = activeFileRef.current;
      const content = fileContentRef.current;
      if (!file || file.isHelp) return;
      try {
        await writeFile(file.handle, content);
        setSaveStatus('Saved');
        setTimeout(() => setSaveStatus(''), 2000);
      } catch (err) {
        console.error('Auto-save failed:', err);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [fileContent, activeFile, writeFile]);

  // Drag-to-resize sidebar
  const startResize = useCallback((e) => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(180, Math.min(600, e.clientX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Welcome screen
  if (!rootHandle && !isLoading) {
    return (
      <div className="welcome-screen">
        <div className="welcome-inner">
          <div className="welcome-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <h1 className="welcome-title">Markdown Editor</h1>
          <p className="welcome-subtitle">Open a vault to start editing your notes.</p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="welcome-btn" style={{ margin: 0 }} onClick={pickDirectory}>
              Open Vault
            </button>
            {previousVault && (
              <button
                className="welcome-btn"
                style={{ margin: 0, background: 'var(--background-modifier-border)', color: 'var(--text-normal)' }}
                onClick={restoreVault}
              >
                Restore '{previousVault.name}'
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="welcome-screen">
        <div className="welcome-inner">
          <p className="welcome-subtitle">Loading vault...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <div className="workspace-sidebar" style={{ width: sidebarWidth }}>
        <FileExplorer
          rootHandle={rootHandle}
          fileTree={fileTree}
          activeFilePath={activeFile?.path || null}
          onFileClick={handleFileClick}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onChangeVault={pickDirectory}
          onTrash={handleTrash}
          expandedPaths={expandedPaths}
          onToggleExpand={handleToggleExpand}
          onMoveFile={moveFile}
          onRenameFile={handleRenameFile}
        />
        <div className="theme-toggle-container">
          <button
            className="theme-toggle-btn"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
                Switch to Light Mode
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                Switch to Dark Mode
              </>
            )}
          </button>
        </div>
        <div className="sidebar-bottom-actions">
          <button
            className="theme-toggle-btn settings-btn"
            onClick={handleHelpClick}
            title="Help & Guide"
          >
            <HelpCircle size={16} />
            Help Guide
          </button>
          <button
            className="theme-toggle-btn settings-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            <Settings size={16} />
            Settings
          </button>
        </div>
      </div>
      <div className="workspace-resize-handle" onMouseDown={startResize} />
      <div className="workspace-main">
        <EditorPane
          activeFile={activeFile}
          fileContent={fileContent}
          theme={theme}
          editorMode={editorMode}
          saveStatus={saveStatus}
          onContentChange={setFileContent}
          onSave={handleSave}
        />
      </div>
      {showSettings && (
        <SettingsPanel
          editorFontSize={editorFontSize}
          treeFontSize={treeFontSize}
          editorPadding={editorPadding}
          onEditorFontSizeChange={setEditorFontSize}
          onTreeFontSizeChange={setTreeFontSize}
          onEditorPaddingChange={setEditorPadding}
          onResetDefaults={handleResetDefaults}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
