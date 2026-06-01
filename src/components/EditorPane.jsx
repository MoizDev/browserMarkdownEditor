import React, { useEffect, useRef } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from '../editor/cmTheme.js';
import { createLivePreviewPlugin } from '../editor/livePreview.js';
import { markdownFormatExtension } from '../editor/formatKeymap.js';
import { Compartment } from '@codemirror/state';
import { useFileSystem } from '../context/FileSystemContext.jsx';
import 'katex/dist/katex.min.css';

export default function EditorPane({ activeFile, fileContent, theme, editorMode, saveStatus, onContentChange, onSave, onOpenNote }) {
    const { getAssetUrl, saveAsset } = useFileSystem();
    const editorContainerRef = useRef(null);
    const viewRef = useRef(null);
    const themeCompartmentRef = useRef(new Compartment());
    const readOnlyCompartmentRef = useRef(new Compartment());
    const livePreviewCompartmentRef = useRef(new Compartment());
    const onContentChangeRef = useRef(onContentChange);
    const activeFileRef = useRef(activeFile);
    const onOpenNoteRef = useRef(onOpenNote);
    const saveScrollTimeoutRef = useRef(null);

    // Debounced scroll persistence
    const handleScroll = (view) => {
        if (!activeFileRef.current) return;
        const path = activeFileRef.current.path;
        const scrollTop = view.scrollDOM.scrollTop;

        if (saveScrollTimeoutRef.current) clearTimeout(saveScrollTimeoutRef.current);

        saveScrollTimeoutRef.current = setTimeout(() => {
            try {
                const stored = localStorage.getItem('fileScrollPositions');
                const positions = stored ? JSON.parse(stored) : {};
                positions[path] = scrollTop;
                localStorage.setItem('fileScrollPositions', JSON.stringify(positions));
            } catch (err) {
                console.error('Failed to save scroll position:', err);
            }
        }, 300);
    };

    // Keep the callback ref up-to-date without re-creating the editor
    useEffect(() => {
        onContentChangeRef.current = onContentChange;
    }, [onContentChange]);

    useEffect(() => {
        activeFileRef.current = activeFile;
    }, [activeFile]);

    useEffect(() => {
        onOpenNoteRef.current = onOpenNote;
    }, [onOpenNote]);

    // Create a bound version of getAssetUrl that includes the active file's parent handle
    const boundGetAssetUrl = useRef((fileName) => getAssetUrl(fileName, null));
    useEffect(() => {
        boundGetAssetUrl.current = (fileName) => getAssetUrl(fileName, activeFile?.parentHandle || null);
    }, [activeFile, getAssetUrl]);

    // Use a callback ref to initialize CodeMirror as soon as the container is mounted in the DOM.
    const setEditorContainer = (node) => {
        editorContainerRef.current = node;
        if (node && !viewRef.current) {
            const updateListener = EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onContentChangeRef.current(update.state.doc.toString());
                }
            });

            const state = EditorState.create({
                doc: fileContent || '',
                extensions: [
                    EditorView.lineWrapping,
                    // Draw a custom cursor element (.cm-cursor) instead of using the
                    // native browser caret, so the caret style/animation settings apply.
                    drawSelection(),
                    history(),
                    closeBrackets(),
                    markdown({ base: markdownLanguage, codeLanguages: languages }),
                    themeCompartmentRef.current.of([
                        theme === 'light' ? obsidianLightTheme : obsidianDarkTheme,
                        theme === 'light' ? obsidianLightHighlightStyle : obsidianHighlightStyle
                    ]),
                    keymap.of([
                        ...defaultKeymap,
                        ...historyKeymap,
                        ...closeBracketsKeymap,
                        ...searchKeymap,
                    ]),
                    readOnlyCompartmentRef.current.of(EditorView.editable.of(editorMode !== 'read')),
                    livePreviewCompartmentRef.current.of(createLivePreviewPlugin((fn) => boundGetAssetUrl.current(fn), editorMode)),
                    markdownFormatExtension,
                    updateListener,
                    EditorView.domEventHandlers({
                        paste(event, view) {
                            const items = event.clipboardData?.items;
                            if (!items) return false;

                            for (const item of items) {
                                if (item.type.startsWith('image/')) {
                                    event.preventDefault();
                                    const blob = item.getAsFile();

                                    // Generate a filename like Obsidian: Pasted image 20231025143000.png
                                    const now = new Date();
                                    const timestamp = now.getFullYear().toString() +
                                        (now.getMonth() + 1).toString().padStart(2, '0') +
                                        now.getDate().toString().padStart(2, '0') +
                                        now.getHours().toString().padStart(2, '0') +
                                        now.getMinutes().toString().padStart(2, '0') +
                                        now.getSeconds().toString().padStart(2, '0');

                                    // Make sure we carry over the correct extension (e.g. image/png -> .png)
                                    const extMatch = item.type.match(/image\/(jpeg|png|gif|webp|svg\+xml)/);
                                    let ext = '.png';
                                    if (extMatch) {
                                        ext = `.${extMatch[1] === 'svg+xml' ? 'svg' : extMatch[1]}`;
                                    }
                                    const filename = `Pasted image ${timestamp}${ext}`;

                                    // Save the asset to the local .Assets folder (sibling of the active file)
                                    const parentHandle = activeFileRef.current?.parentHandle || null;
                                    saveAsset(filename, blob, parentHandle).then(() => {
                                        // Insert the markdown at cursor
                                        const insertText = `![[${filename}]]\n`;
                                        const ranges = view.state.selection.ranges;
                                        if (ranges.length > 0) {
                                            const pos = ranges[0].from;
                                            view.dispatch({
                                                changes: { from: pos, insert: insertText },
                                                selection: { anchor: pos + insertText.length }
                                            });
                                        }
                                    }).catch(err => {
                                        console.error('Failed to save pasted image:', err);
                                        alert('Failed to save image to .Assets folder.');
                                    });

                                    return true; // We handled the paste
                                }
                            }
                            return false;
                        },
                        scroll(event, view) {
                            handleScroll(view);
                        },
                        mousedown(event) {
                            // Navigate when a rendered [[wikilink]] is clicked.
                            const el = event.target.closest?.('.cm-wikilink');
                            if (el && onOpenNoteRef.current) {
                                event.preventDefault();
                                onOpenNoteRef.current(el.getAttribute('data-wikilink'));
                                return true;
                            }
                            return false;
                        }
                    })
                ],
            });

            viewRef.current = new EditorView({
                state,
                parent: node,
            });
        }
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (viewRef.current) {
                viewRef.current.destroy();
                viewRef.current = null;
            }
        };
    }, []);

    // Swap document content when the active file changes
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;

        const currentDoc = view.state.doc.toString();
        if (currentDoc !== fileContent) {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: fileContent,
                },
            });
        }

        // Restore scroll position after setting content
        if (activeFile) {
            try {
                const stored = localStorage.getItem('fileScrollPositions');
                const positions = stored ? JSON.parse(stored) : {};
                const savedScrollTop = positions[activeFile.path];

                requestAnimationFrame(() => {
                    if (viewRef.current) {
                        viewRef.current.scrollDOM.scrollTop = savedScrollTop !== undefined ? savedScrollTop : 0;
                    }
                });
            } catch (err) {
                console.error('Failed to restore scroll position:', err);
            }
        }
    }, [activeFile, fileContent]);

    // Update CodeMirror theme when app theme changes
    useEffect(() => {
        const view = viewRef.current;
        if (view) {
            view.dispatch({
                effects: themeCompartmentRef.current.reconfigure([
                    theme === 'light' ? obsidianLightTheme : obsidianDarkTheme,
                    theme === 'light' ? obsidianLightHighlightStyle : obsidianHighlightStyle
                ])
            });
        }
    }, [theme]);

    // Update read-only & live-preview rules when mode or active file changes
    useEffect(() => {
        const view = viewRef.current;
        if (view) {
            view.dispatch({
                effects: [
                    readOnlyCompartmentRef.current.reconfigure(EditorView.editable.of(editorMode !== 'read')),
                    livePreviewCompartmentRef.current.reconfigure(createLivePreviewPlugin((fn) => boundGetAssetUrl.current(fn), editorMode))
                ]
            });
        }
    }, [editorMode, activeFile]);

    if (!activeFile) {
        return (
            <div className="editor-pane">
                <div className="editor-empty">
                    <div className="editor-empty-inner">
                        <p className="editor-empty-title">No file open</p>
                        <p className="editor-empty-hint">Select a file from the sidebar to begin editing.</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="editor-pane">
            <div className="view-header">
                <span className="view-header-title">
                    {activeFile.name} {editorMode === 'read' && <span style={{ opacity: 0.6, fontStyle: 'italic', marginLeft: 6 }}>(Read-Only)</span>}
                </span>
                {saveStatus && <span className="save-status">{saveStatus}</span>}
            </div>
            <div
                className="view-content"
                ref={setEditorContainer}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                    e.preventDefault();
                    const items = e.dataTransfer.items;
                    if (items && items.length > 0) {
                        const item = items[0];
                        if (item.kind === 'file') {
                            const file = item.getAsFile();
                            if (file && file.name.endsWith('.md')) {
                                const text = await file.text();
                                onContentChange(text);
                                const view = viewRef.current;
                                if (view) {
                                    view.dispatch({
                                        changes: { from: 0, to: view.state.doc.length, insert: text },
                                    });
                                }
                            }
                        }
                    }
                }}
            />
        </div>
    );
}
