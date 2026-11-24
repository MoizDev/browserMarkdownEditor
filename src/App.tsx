import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFileSystem } from './context/FileSystemContext';
import './index.css';
import FileExplorer from './components/FileExplorer';
import SidebarFooter from './components/SidebarFooter';
import { SidebarRailExpand } from './components/SidebarRailExpand';
import ConfirmDialog from './components/ConfirmDialog';
import ContextMenu from './components/ContextMenu';
import EditorPane from './components/EditorPane';
import TerminalDock from './components/TerminalDock';
import RecoverySurface from './components/RecoverySurface';
import { LoadingScreen, VaultProblemScreen, WelcomeScreen } from './components/WelcomeScreen';
import { closeContextMenu } from './utils/contextMenu';
import { useRefuseUnclaimedDrop } from './app/useRefuseUnclaimedDrop';
import { useLiveVault } from './app/useLiveVault';
import { useStatusLine } from './app/useStatusLine';
import { useOpenDocuments } from './app/useOpenDocuments';
import { useAppSettings } from './app/useAppSettings';
import { useAppDialogs } from './app/useAppDialogs';
import { useMainView } from './app/useMainView';
import { useOverlayPanels } from './app/useOverlayPanels';
import { useExplorerState } from './app/useExplorerState';
import { useVaultMoves } from './app/useVaultMoves';
import { useVaultIndex } from './app/useVaultIndex';
import { useRecoveryJournal } from './app/useRecoveryJournal';
import { useSessionPersistence } from './app/useSessionPersistence';
import { useSidebar } from './app/useSidebar';
import { useSidePanels } from './app/useSidePanels';
import { useAssetLifecycle } from './app/useAssetLifecycle';
import { usePdfSeeds } from './app/usePdfSeeds';
import { useDocumentOpener } from './app/useDocumentOpener';
import { useEntryStyles } from './app/useEntryStyles';
import { useDiskState } from './app/useDiskState';
import { useNativeCanvasHost } from './app/useNativeCanvasHost';
import { useConversionRestore } from './app/useConversionRestore';
import { useNotebookExport } from './app/useNotebookExport';
import { useExternalUrlsPerVault } from './app/externalOpen';
import { useSaveFunnel } from './app/useSaveFunnel';
import { usePdfActions } from './app/usePdfActions';
import { useVaultOpeners } from './app/useVaultOpeners';
import { useTabLifecycle } from './app/useTabLifecycle';
import { usePaneActions } from './app/usePaneActions';
import { useVaultSwitch } from './app/useVaultSwitch';
import { useAppLink, useUrlWriter } from './app/appLink';
import { useSessionRestore } from './app/useSessionRestore';
import { usePanePrefetch } from './app/usePanePrefetch';
import { useCreateEntries } from './app/useCreateEntries';
import { useTrashActions } from './app/useTrashActions';
import { useRenameMove } from './app/useRenameMove';
import { useOutsideChanges } from './app/useOutsideChanges';
import { useUpdateNotice } from './app/useUpdateNotice';
import { useDiskBarActions } from './app/useDiskBarActions';
import { useAgentCanvasAccess } from './app/useAgentCanvasAccess';
import { useVaultIdentity } from './app/useVaultIdentity';
import { useAgentHostDeps } from './app/useAgentHostDeps';
import { useReaderIntegration } from './app/useReaderIntegration';
import { useGlobalShortcuts } from './app/useGlobalShortcuts';
import { useRecoveryActions } from './app/useRecoveryActions';
import { useEditableCopy } from './app/useEditableCopy';
import { requestDocumentKeyboard } from './utils/documentKeyboard';
import SaveNotices from './components/SaveNotices';
import { moduleSlot } from './components/moduleSlot';
import { AppFailure, AppRecoveryProvider, ErrorBoundary, PartFailureBox } from './components/ErrorBoundary';
import { opensInApp } from './utils/documentReading';
import type { FileTreeNode } from './types';
import type { NativeCanvasHost } from './types/nativeCanvas';

// The AI agent panel and everything under it (its CSS, the WebSocket bridge,
// the reply renderer, the aicss components) load on first open — a reader who
// never opens it downloads none of it.
// Module slots, not React.lazy: React.lazy keeps a rejected import for the life of the page, so one dropped request
// (or a redeploy) made the panel unopenable until reload; a slot imports again on its boundary's Try again.
const AgentPanel = moduleSlot(() => import('./components/AgentPanel')).View;
// Opened on demand and never on the way to typing: Settings, the Trash bin and
// the graph are each a panel the reader asks for, so none of them belongs in
// the chunk that has to land before the editor does. `prefetchPanes` warms the
// heavy ones at idle; these are small enough to fetch on the click.
const SettingsPanel = moduleSlot(() => import('./components/SettingsPanel')).View;
const TrashPanel = moduleSlot(() => import('./components/TrashPanel')).View;
const GraphView = moduleSlot(() => import('./components/GraphView')).View;

/** A lazy panel's failure, inside the panel's own place (the agent dock, the main view). */
function panelFailure(what: string) {
  return (error: unknown, retry: () => void) => (
    <div className="part-failure-host">
      <PartFailureBox error={error} retry={retry} what={what} />
    </div>
  );
}

/** A modal panel's failure (Settings, Trash): the same card over the workspace, closable as the panel was. */
function modalFailure(what: string, close: () => void) {
  return (error: unknown, retry: () => void) => (
    <div className="settings-overlay" onClick={close}>
      <div className="part-failure-card" onClick={event => event.stopPropagation()}>
        <PartFailureBox error={error} retry={retry} what={what} />
        <button type="button" className="part-failure-close" aria-label={`Close ${what}`} onClick={close}>×</button>
      </div>
    </div>
  );
}

/**
 * The composition root. Every piece of the app's state lives in a module of its
 * own under `src/app/`, each one hook with explicit inputs; App calls them in
 * the order their effects must run, hands each what it needs, and draws the
 * workspace. Orders that matter: the session's persist effect runs before the
 * vault switch, the switch before the restore pass, and the restore before the
 * URL writer — each reads what the one before it just set on the same commit.
 */
export default function App() {
  useRefuseUnclaimedDrop();

  const {
    rootHandle,
    handleIO,
    ensureVaultId,
    registerBeforeRootChange,
    fileTree,
    isLoading,
    vaultProblem,
    retryVault,
    previousVault,
    linkedVault,
    recentVaults,
    currentVaultId,
    getVaultActivation,
    resolveVaultDir,
    resolveVaultFile,
    verifyVaultFileIdentity,
    vaultDirExists,
    nameTaken,
    pickDirectory: pickDirectoryFromFileSystem,
    openRecentVault,
    openFolderAsVault,
    openLinkedVault,
    forgetRecentVault,
    pinRecentVault,
    readFile,
    writeFile,
    readFileBytes,
    writeFileBytes,
    importFiles,
    createFile,
    createFolder,
    retireAsset,
    restoreAsset,
    restoreVault,
    requestIndexPermission,
    moveToTrash,
    keepCopyInGarbage,
    keepConversionBackup,
    listTrash,
    restoreFromTrash,
    restoreConversionCopy,
    copyTrashFile,
    deleteFromTrash,
    emptyTrash,
    moveFile,
    renameFile,
    readFileVersioned,
    readFileSnapshot,
    readBoardAsset,
    readLegacyBoardAsset,
    putBoardAsset,
    writeBoardCopy,
    readBytesVersioned,
    inspectExportTarget,
    writeNotebookExport,
    statFile,
    writeFileVersioned,
    writeConflictCopy,
    writeDistinctCopy,
    recreateFile,
    resolveFileHandle,
    subscribeVaultChanges,
    liveDetection,
  } = useFileSystem();

  const { currentVaultIdRef, rootHandleRef, fileTreeRef, readerEpochRef } = useLiveVault(rootHandle, currentVaultId, fileTree);
  const { saveStatus, setSaveStatus, showStatus, holdStatus, announce } = useStatusLine();
  // An old board's editable copy is composed after the opener and the canvas host that call into it (useEditableCopy).
  const editableCopyRef = useRef<NativeCanvasHost['makeEditableCopy'] | null>(null);
  const oldBoardOpenedRef = useRef<((id: string, name: string) => void) | null>(null);
  const {
    tabs, setTabs, setClosingDocumentIds, closingRef, reopenedClosingRef, layout, setLayout,
    activeTabPath, activeFile, tabsRef, sessionReportRef, nativeTransitionRef,
    bytesGenerationsRef, bufferPathIdsRef, documentBuffers, seedDocumentBuffer, documentSessions,
    markdownSessions, bumpBytesGeneration, invalidReaderTokens, layoutRef, activeTabPathRef,
    visiblePathsRef, saveTimersRef, ensureCanvasBridge, attachNativeCanvasSession, nativePoliciesRef,
    onNativeCanvasReady, contentOf, flushingRef, readerIdentityCache
  } = useOpenDocuments({
    getVaultActivation
  });

  const {
    theme, toggleTheme, editorFontSize, setEditorFontSize, codeFontSize, setCodeFontSize,
    rainbowBrackets, setRainbowBrackets, treeFontSize, setTreeFontSize, editorPadding, setEditorPadding,
    tabSize, setTabSize, recentVaultLimit, setRecentVaultLimit, showVaultInTitle, setShowVaultInTitle,
    caretStyle, setCaretStyle, caretThickness, setCaretThickness, smoothCaret, setSmoothCaret,
    caretSpeed, setCaretSpeed, fontFamily, setFontFamily, accentColor, setAccentColor, codeBlockColor,
    setCodeBlockColor, handleResetDefaults
  } = useAppSettings({
    rootHandle
  });

  const { dialog, dialogRef, ask, askChoice, tell, askForName, notify, notifyRef, tellRef } = useAppDialogs();
  const {
    mainView, setMainView, toggleGraph, contextMenu
  } = useMainView({
    rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef
  });

  const { showSettings, setShowSettings, openSettings, showTrash, setShowTrash, openTrash } = useOverlayPanels(rootHandle);
  const closeSettings = useCallback(() => setShowSettings(false), [setShowSettings]);
  const closeTrash = useCallback(() => setShowTrash(false), [setShowTrash]);
  const { searchOpen, setSearchOpen, openSearch, closeSearch, handleToggleExpand, expandPaths, collapsePaths } = useExplorerState(rootHandle);
  const { restorePendingRef, vaultMovesRef, trackVaultMove, pendingFor, trashInFlightRef } = useVaultMoves();

  // The index asks for the asset backlog when a folder's media listing turns
  // fresh; the asset lifecycle that owns the backlog is declared after it and
  // reads the index, so the call is bound late through this ref.
  const requeueBackloggedAssetsRef = useRef<() => void>(() => {});
  const indexMediaChanged = useCallback(() => requeueBackloggedAssetsRef.current(), []);
  const {
    searchActivation, searchToken, graph, graphFreshness, indexProblem, indexGraphRef, indexMediaAssets,
    retryIndex, rebuildIndex, indexRestoreSettled, getWikiLinkTargets, searchController, searchAgent
  } = useVaultIndex({
    rootHandle, currentVaultId, fileTree, getVaultActivation, resolveFileHandle, statFile, handleIO,
    requestIndexPermission, indexMediaChanged, tabsRef, documentBuffers, contentOf
  });

  const { recoveryJournal, recoveryEvent } = useRecoveryJournal(announce);
  const {
    sessionRootRef, sessionVaultIdRef, restoringRef, sessionSealedRef
  } = useSessionPersistence({
    rootHandle, currentVaultId, layout, indexRestoreSettled
  });

  const {
    sidebarWidth, sidebarCollapsed, setSidebarCollapsed, isDraggingSidebar, collapseSidebar, startResize
  } = useSidebar({
    setSearchOpen
  });

  const {
    agentPanelOpen, agentPanelWidth, agentOpenedByReader, toggleAgentPanel,
    closeAgentPanel, startAgentResize, terminalOpen, terminalOpenedByUser, toggleTerminal, hideTerminal
  } = useSidePanels({
    rootHandleRef
  });

  const {
    assetRefsRef, boardBaselinesRef, rememberAssetRefs, moveAssetRefs, assetActivationsRef,
    assetReferenceRevisionRef, reconcileQueueRef, queueReconcile, requeueAssetsAffected,
    requeueAllAssets, assetReadableWakeRef, requeueBackloggedAssets
  } = useAssetLifecycle({
    rootHandle, fileTree, getVaultActivation, handleIO, readFile, retireAsset, restoreAsset, tabs,
    tabsRef, documentBuffers, documentSessions, indexGraphRef
  });

  useLayoutEffect(() => { requeueBackloggedAssetsRef.current = requeueBackloggedAssets; }, [requeueBackloggedAssets]);

  const {
    seedPdfBaseline, pdfSeedForRef, pdfSeedsRef, pdfSeedSourcesRef
  } = usePdfSeeds({
    readBytesVersioned
  });

  const {
    retryUnreadTabRef, handleFileClick, openNoteByName, handleOpenNode, pendingReveal, setPendingReveal,
    handleOpenSearchResult, handleRevealHandled, handleHelpClick
  } = useDocumentOpener({
    handleIO, readFileVersioned, fileTree, rootHandleRef, tabsRef, closingRef, reopenedClosingRef,
    setLayout, setTabs, setSaveStatus, setMainView, rememberAssetRefs, seedPdfBaseline,
    seedDocumentBuffer, oldBoardOpenedRef
  });
  // A click (or Enter) on a file in the tree opens it AND gives it the keyboard, as a tab-bar click does: the
  // keyboard otherwise stays on the tree row, so a drawing's first tool shortcut went nowhere.
  const openFromTree = useCallback(async (node: FileTreeNode) => {
    if (await handleFileClick(node) && opensInApp(node.name)) requestDocumentKeyboard(node.path);
  }, [handleFileClick]);

  const {
    writeEntryStyles, handleStyleEntry, handleSetTreeOrder
  } = useEntryStyles({
    rootHandle, handleIO, fileTree, fileTreeRef, writeFile, notify
  });

  const {
    pdfRebuildRef, setPdfRebuildNotice, diskStateRef, setDiskState, currentPdfOwner,
    onAnnotationPreflight, keepPdfBaseline
  } = useDiskState({
    readBytesVersioned, keepCopyInGarbage, setTabs, tabsRef, rootHandleRef, currentVaultIdRef,
    readerEpochRef, invalidReaderTokens, reconcileQueueRef, trashInFlightRef
  });

  const {
    nativeCanvasHost
  } = useNativeCanvasHost({
    getVaultActivation, tabsRef, documentSessions, documentBuffers, nativePoliciesRef, diskStateRef,
    rootHandleRef, currentVaultIdRef, flushingRef, saveTimersRef, nativeTransitionRef, sessionReportRef,
    dialogRef, ask, recoveryEvent, recoveryJournal, readFileSnapshot, readBoardAsset,
    readLegacyBoardAsset, putBoardAsset, keepConversionBackup, editableCopyRef
  });

  useConversionRestore({
    announce, notify, documentSessions, getVaultActivation, handleIO, listTrash, readFileVersioned,
    restoreConversionCopy, rootHandle, tabsRef, nativePoliciesRef, trashInFlightRef, reconcileQueueRef
  });

  const {
    handleOpenNotebookSource, handleExportNotebook
  } = useNotebookExport({
    fileTree, handleFileClick, tell, ask, notify, getVaultActivation, tabsRef, setTabs, rootHandleRef,
    currentVaultIdRef, readerEpochRef, trashInFlightRef, reconcileQueueRef, inspectExportTarget,
    writeNotebookExport
  });

  useExternalUrlsPerVault(rootHandle);

  const {
    writeFileRef, writeFileVersionedRef, clearSaveTimer, flushChainsRef, syncExitGuard,
    flushTab, scheduleSave, updateTabContent, checkpointNow
  } = useSaveFunnel({
    writeFile, writeFileBytes, writeFileVersioned, writeConflictCopy, getVaultActivation,
    currentVaultIdRef, rootHandleRef, indexGraphRef, recoveryEvent, trashInFlightRef, notifyRef, tellRef,
    setSaveStatus, showStatus, tabsRef, setTabs, documentBuffers, documentSessions, sessionReportRef,
    nativeTransitionRef, nativePoliciesRef, bytesGenerationsRef, bumpBytesGeneration, visiblePathsRef,
    saveTimersRef, flushingRef, nativeCanvasHost, pdfRebuildRef, diskStateRef, setDiskState,
    setPdfRebuildNotice, currentPdfOwner, keepPdfBaseline, pdfSeedForRef, pdfSeedsRef, assetRefsRef,
    boardBaselinesRef, assetActivationsRef, assetReferenceRevisionRef, reconcileQueueRef, queueReconcile,
    requeueAssetsAffected
  });

  const {
    handleUnsignedPdfCopy, preparePdfPrint, rotatePdf, preparePdfDeparture, canLeavePdfVault
  } = usePdfActions({
    getVaultActivation, readFileSnapshot, readBytesVersioned, writeDistinctCopy, ask,
    tell, notifyRef, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef, activeTabPathRef,
    documentBuffers, documentSessions, setTabs, nativePoliciesRef, bytesGenerationsRef,
    bumpBytesGeneration, flushingRef, flushTab, flushChainsRef, writeFileVersionedRef, diskStateRef,
    setDiskState, currentPdfOwner, pdfSeedForRef
  });

  const {
    pickDirectorySafely, openRecentVaultSafely, handleOpenAsVault
  } = useVaultOpeners({
    pickDirectoryFromFileSystem, openRecentVault, openFolderAsVault, canLeavePdfVault, notify, tell
  });
  // "Open another vault…" on the loading and problem screens. Neither draws the workspace's notice bar, so a pick
  // that was refused or failed is said in a dialog: unsaid, the button did nothing at all, on the two screens whose
  // whole purpose is a way on.
  const openOtherVault = useCallback(() => {
    void pickDirectorySafely().then(result => {
      if (result === 'ok') return;
      void tell(result === 'busy'
        ? { title: 'Still opening a folder', body: 'The app is still reading a folder that was picked a moment ago. Wait for it to finish, or reload the app to stop it.', confirmLabel: 'OK' }
        : { title: 'That folder could not be opened', body: 'Nothing was changed. Check that the folder still exists and that this browser may read it, then try again.', confirmLabel: 'OK' });
    });
  }, [pickDirectorySafely, tell]);

  const {
    releaseTab, releaseOverwritten, removeTab, closeDocuments, closeTab, reopenClosedTab, retryUnreadTab,
    changeTabMode, toggleTabMode
  } = useTabLifecycle({
    clearSaveTimer, tabsRef, documentSessions, bufferPathIdsRef, documentBuffers, syncExitGuard,
    recoveryEvent, bytesGenerationsRef, invalidReaderTokens, readerIdentityCache, pdfSeedsRef,
    pdfSeedSourcesRef, diskStateRef, pdfRebuildRef, indexGraphRef, assetRefsRef, boardBaselinesRef,
    assetReadableWakeRef, flushTab, setLayout, setTabs, currentVaultId, currentVaultIdRef, closingRef,
    reopenedClosingRef, rootHandleRef, readerEpochRef, setClosingDocumentIds, notifyRef, tell,
    preparePdfDeparture, fileTreeRef, handleFileClick, retryUnreadTabRef, rememberAssetRefs,
    readFileVersioned, readBytesVersioned, resolveFileHandle, bumpBytesGeneration, seedDocumentBuffer,
    setDiskState
  });

  useEditableCopy({
    ask, tell, announce, getVaultActivation, writeBoardCopy, handleIO, rootHandleRef, tabsRef, layoutRef, nativePoliciesRef,
    setTabs, setLayout, handleFileClick, releaseTab, seedDocumentBuffer, editableCopyRef, oldBoardOpenedRef
  });

  const {
    closePaneAndTabs, selectTabInPane, focusPane, splitTabToPane, moveTab, resizePanes, paneBack,
    paneForward
  } = usePaneActions({
    layoutRef, setLayout, tabsRef, rootHandleRef, currentVaultIdRef, readerEpochRef, closeDocuments
  });

  useVaultSwitch({
    rootHandle, registerBeforeRootChange, getVaultActivation, flushTab, documentSessions,
    documentBuffers, recoveryEvent, tabsRef, bytesGenerationsRef, bufferPathIdsRef, pdfSeedsRef,
    pdfSeedSourcesRef, diskStateRef, pdfRebuildRef, assetRefsRef, boardBaselinesRef, setTabs, setLayout,
    setSaveStatus, setPendingReveal, sessionRootRef, sessionVaultIdRef, currentVaultIdRef
  });

  const { initialLocation, linkPendingRef, pendingLinkFile, setPendingLinkFile } = useAppLink();
  useSessionRestore({
    fileTree, rootHandle, currentVaultId, isLoading, recentVaults, readFileVersioned, resolveVaultFile,
    rememberAssetRefs, seedPdfBaseline, seedDocumentBuffer, documentBuffers, indexRestoreSettled,
    initialLocation, linkPendingRef, setPendingLinkFile, sessionRootRef, sessionVaultIdRef, restoringRef,
    sessionSealedRef, notifyRef, restorePendingRef, vaultMovesRef, rootHandleRef, currentVaultIdRef, layoutRef, assetRefsRef,
    boardBaselinesRef, setTabs, setLayout
  });

  usePanePrefetch(fileTree);
  useUrlWriter({ rootHandle, currentVaultId, recentVaults, activeFile, pendingLinkFile, initialLocation, linkPendingRef });

  const {
    handleCreateFile, handleNewNote, handleCreateFolder
  } = useCreateEntries({
    rootHandleRef, setTabs, tell, askForName, getVaultActivation, createFile, createFolder, importFiles,
    resolveVaultFile, nameTaken, handleFileClick
  });

  const {
    handleTrash, trashForAgent, handleTrashRestore, handleTrashCopy, handleTrashDelete,
    handleTrashEmpty, handleTrashReadText, handleTrashReadFile
  } = useTrashActions({
    rootHandle, rootHandleRef, tabsRef, trashInFlightRef, reconcileQueueRef, setSaveStatus, holdStatus,
    showStatus, announce, notify, ask, tell, askChoice, getVaultActivation, moveToTrash,
    restoreFromTrash, copyTrashFile, deleteFromTrash, emptyTrash, readFile, handleIO, removeTab,
    flushTab, preparePdfDeparture, documentSessions, requeueAssetsAffected, writeEntryStyles, pendingFor,
    trackVaultMove
  });

  const {
    retargetPaths, retargetExpandedPaths, handleRenameFile, handleMoveFile
  } = useRenameMove({
    rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, tabsRef, setTabs, setLayout,
    documentBuffers, documentSessions, invalidReaderTokens, saveTimersRef, assetRefsRef,
    boardBaselinesRef, diskStateRef, bufferPathIdsRef, flushChainsRef, notifyRef, announce, pendingFor,
    trackVaultMove, indexGraphRef, recoveryEvent, contentOf, seedDocumentBuffer, flushTab, syncExitGuard,
    clearSaveTimer, scheduleSave, preparePdfDeparture, releaseOverwritten, writeEntryStyles,
    writeConflictCopy, readFileVersioned, resolveVaultFile, renameFile, moveFile, requeueAssetsAffected,
    moveAssetRefs, rememberAssetRefs
  });

  const {
    hasUnsaved, reloadFromDisk, checkOpenDocs
  } = useOutsideChanges({
    rootHandleRef, tabsRef, setTabs, setDiskState, documentBuffers, documentSessions, markdownSessions,
    invalidReaderTokens, saveTimersRef, flushingRef, diskStateRef, pdfRebuildRef, bytesGenerationsRef,
    indexGraphRef, fileTreeRef, assetReferenceRevisionRef, vaultMovesRef, trashInFlightRef, restoringRef,
    bumpBytesGeneration, clearSaveTimer, scheduleSave, seedDocumentBuffer, rememberAssetRefs,
    syncExitGuard, updateTabContent, retargetPaths, retargetExpandedPaths, trackVaultMove,
    requeueAllAssets, requeueAssetsAffected, indexMediaAssets, getVaultActivation, liveDetection,
    subscribeVaultChanges, resolveFileHandle, resolveVaultDir, vaultDirExists, statFile,
    readFileSnapshot, readBytesVersioned, readFileVersioned
  });

  const {
    updateAvailable, reloadUpdatedApp, saveAndReload, dismissUpdate
  } = useUpdateNotice({
    flushingRef, tabsRef, hasUnsaved, documentSessions, documentBuffers, checkpointNow, notifyRef
  });

  const {
    handleDiskAction
  } = useDiskBarActions({
    tabsRef, rootHandleRef, pdfRebuildRef, diskStateRef, nativePoliciesRef, bytesGenerationsRef,
    sessionReportRef, retryUnreadTabRef, indexGraphRef, setTabs, setDiskState, setPdfRebuildNotice,
    currentPdfOwner, keepPdfBaseline, flushTab, documentBuffers, documentSessions, removeTab, hasUnsaved,
    reloadFromDisk, bumpBytesGeneration, clearSaveTimer, syncExitGuard, recoveryEvent, announce, ask,
    tell, getVaultActivation, recreateFile, resolveFileHandle, resolveVaultFile, readBytesVersioned,
    readFileVersioned, writeConflictCopy
  });

  const {
    closedPdfAccess, ensureNativeAgentRuntime, acquireClosedAgentCanvas, readClosedAgentCanvasMedia
  } = useAgentCanvasAccess({
    rootHandle, rootHandleRef, currentVaultIdRef, readerEpochRef, bufferPathIdsRef, tabs, tabsRef,
    documentBuffers, documentSessions, nativePoliciesRef, nativeCanvasHost, attachNativeCanvasSession,
    onNativeCanvasReady, ensureCanvasBridge, announce, getVaultActivation, handleIO, readFileSnapshot,
    statFile, verifyVaultFileIdentity, readBoardAsset, resolveVaultFile
  });

  const {
    settingsVaultId
  } = useVaultIdentity({
    rootHandle, showSettings, ensureVaultId, writeFileRef, rootHandleRef, activeTabPathRef, tabsRef
  });

  const {
    getAgentHostDeps, agentVault
  } = useAgentHostDeps({
    rootHandle, rootHandleRef, tabs, tabsRef, layout, mainView, setMainView, setTabs, setLayout,
    fileTreeRef, assetActivationsRef, indexGraphRef, searchToken, searchAgent, markdownSessions,
    documentBuffers, contentOf, closedPdfAccess, acquireClosedAgentCanvas, readClosedAgentCanvasMedia,
    ensureNativeAgentRuntime, seedPdfBaseline, seedDocumentBuffer, rememberAssetRefs, queueReconcile,
    requeueAssetsAffected, handleRenameFile, handleMoveFile, handleFileClick, trashForAgent,
    changeTabMode, ask, notify, currentVaultId, handleIO, ensureVaultId, fileTree, readFile,
    readFileBytes, readFileVersioned, writeFile, writeFileVersioned, statFile, createFile, createFolder,
    nameTaken, getVaultActivation
  });

  const {
    readerIntegration
  } = useReaderIntegration({
    readFileSnapshot, currentVaultIdRef, readerEpochRef, notify, announce, tabsRef, setTabs, layoutRef,
    setLayout, activeTabPathRef, invalidReaderTokens, readerIdentityCache, diskStateRef, pdfRebuildRef,
    setDiskState, closeTab, reopenClosedTab, checkOpenDocs
  });

  useGlobalShortcuts({
    flushTab, handleNewNote, toggleTabMode, activeTabPathRef, setSidebarCollapsed
  });

  const {
    inspectRecovery, recoverEntry, saveRecoveryCopy
  } = useRecoveryActions({
    getVaultActivation, rootHandle, currentVaultId, recentVaults, handleIO, resolveFileHandle,
    resolveVaultFile, readFileSnapshot, readBoardAsset, putBoardAsset, writeConflictCopy,
    writeFileVersioned, rootHandleRef, currentVaultIdRef, announce, tabsRef, documentBuffers,
    markdownSessions, contentOf, hasUnsaved
  });

  // The welcome screen can report a refused open too; returning before the
  // workspace's host used to hide the app notice on exactly that path.
  const dialogHost = dialog && (
    <ConfirmDialog
      questionId={dialog.id ?? 0}
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      cancelLabel={dialog.cancelLabel}
      danger={dialog.danger}
      input={dialog.input}
      altLabel={dialog.altLabel}
      onAlt={dialog.onAlt}
      onConfirm={dialog.onConfirm}
      onCancel={dialog.onCancel}
    >
      {dialog.body}
    </ConfirmDialog>
  );


  // Whether the workspace on screen is this vault's restored session — the
  // graph keeps its layout per vault only then. Read in render because the
  // claim is made by the restore effect, and the graph must key on its result.
  // eslint-disable-next-line react-hooks/refs -- the claim lives in refs by design (useSessionPersistence)
  const sessionRestored = sessionRootRef.current === rootHandle && sessionVaultIdRef.current === currentVaultId;

  const appRecovery = useMemo(() => ({ saveAndReload }), [saveAndReload]);

  const updateNotice = updateAvailable && (
    <div className="app-update-notice" role="status">
      <span>A new version is available.</span>
      <button type="button" onClick={reloadUpdatedApp}>Reload</button>
      <button type="button" aria-label="Dismiss update notice" onClick={dismissUpdate}>×</button>
    </div>
  );

  // Every screen below is drawn inside one boundary that App itself sits above, so a part that fails to draw leaves
  // App — its tabs, buffers and save machinery — mounted, and the failure screen can still save before reloading.
  const guard = (screen: ReactNode) => (
    <AppRecoveryProvider value={appRecovery}>
      <ErrorBoundary label="The workspace" fallback={(error, retry) => <AppFailure error={error} retry={retry} />}>
        {screen}
      </ErrorBoundary>
    </AppRecoveryProvider>
  );

  if (!rootHandle && !isLoading) {
    return guard(
      <WelcomeScreen
        linkedVault={linkedVault}
        previousVault={previousVault}
        onOpenLinkedVault={openLinkedVault}
        onPickDirectory={pickDirectorySafely}
        onRestoreVault={() => { void restoreVault().then(requeueAllAssets); }}
      >
        {dialogHost}
        {updateNotice}
      </WelcomeScreen>
    );
  }

  if (isLoading) {
    return guard(
      <LoadingScreen onOpenOther={openOtherVault} onReload={() => window.location.reload()}>
        {dialogHost}
        {updateNotice}
      </LoadingScreen>
    );
  }

  if (vaultProblem) {
    return guard(
      <VaultProblemScreen problem={vaultProblem} onRetry={() => { void retryVault(); }} onOpenOther={openOtherVault}>
        {dialogHost}
        {updateNotice}
      </VaultProblemScreen>
    );
  }

  return guard(
    <div className="workspace">
      {sidebarCollapsed && (
        <div className="sidebar-rail">
          <SidebarRailExpand onExpand={() => setSidebarCollapsed(false)} />
        </div>
      )}
      <div
        className={`workspace-sidebar${sidebarCollapsed ? ' collapsed' : ''}${isDraggingSidebar ? ' resizing' : ''}`}
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      >
        <ErrorBoundary label="The sidebar" fallback={panelFailure('the sidebar')}>
        <FileExplorer
          readSnapshot={handleIO.file}
          rootHandle={rootHandle}
          search={searchController}
          fileTree={fileTree}
          onFileClick={openFromTree}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onCollapse={collapseSidebar}
          searchOpen={searchOpen}
          onOpenSearch={openSearch}
          onCloseSearch={closeSearch}
          onTrash={handleTrash}
          onOpenAsVault={handleOpenAsVault}
          onStyleEntry={handleStyleEntry}
          onToggleExpand={handleToggleExpand}
          onExpandPaths={expandPaths}
          onCollapsePaths={collapsePaths}
          onMoveFile={handleMoveFile}
          onSetTreeOrder={handleSetTreeOrder}
          onRenameFile={handleRenameFile}
          onImportFiles={importFiles}
          onOpenSearchResult={handleOpenSearchResult}
        />
        <SidebarFooter
          vaultName={rootHandle?.name ?? ''}
          fileTree={fileTree}
          recentVaults={recentVaults}
          currentVaultId={currentVaultId}
          recentVaultLimit={recentVaultLimit}
          onOpenRecentVault={openRecentVaultSafely}
          onForgetRecentVault={forgetRecentVault}
          onPinRecentVault={pinRecentVault}
          onChangeVault={pickDirectorySafely}
          onRebuildIndex={rebuildIndex}
          graphOpen={mainView === 'graph'}
          onToggleGraph={toggleGraph}
          agentOpen={agentPanelOpen}
          onToggleAgent={toggleAgentPanel}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenTrash={openTrash}
          onOpenHelp={handleHelpClick}
          onOpenSettings={openSettings}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        </ErrorBoundary>
      </div>
      {!sidebarCollapsed && <div className="workspace-resize-handle" onMouseDown={startResize} />}
      <div className="workspace-main">
        {currentVaultId && rootHandle && (
          // An offer surface: if it cannot draw, the workspace goes on without it (the console says why).
          <ErrorBoundary key={currentVaultId} label="The recovery offers" fallback={() => null}>
            <RecoverySurface vaultId={currentVaultId} activePath={activeTabPath} inspect={inspectRecovery} recover={recoverEntry} saveCopy={saveRecoveryCopy} status={announce} journal={recoveryJournal} />
          </ErrorBoundary>
        )}
        {indexProblem?.activation === searchActivation && (
          <div className="disk-bar" role="alert">
            <span className="disk-bar-message">{indexProblem.kind === 'permission' ? 'Vault access is needed to update the search index.' : 'Search index unavailable.'}</span>
            <div className="disk-bar-actions"><button className="disk-bar-btn is-primary" onClick={() => { void retryIndex(); }}>Retry</button></div>
          </div>
        )}
        {mainView === 'graph' ? (
          <ErrorBoundary label="The graph view" fallback={panelFailure('the graph view')}>
          <GraphView
            fallback={<div className="workspace-agent-loading">Loading…</div>}
            key={`${searchActivation}:${sessionRestored ? currentVaultId : ''}`}
            vaultKey={sessionRestored && currentVaultId
              ? `vault:${currentVaultId}` : `activation:${searchActivation}`}
            indexing={graphFreshness?.activation !== searchActivation}
            updating={graphFreshness?.activation === searchActivation && graphFreshness.stale}
            nodes={graph.nodes}
            links={graph.links}
            activeFilePath={activeFile?.path || null}
            onOpenNode={handleOpenNode}
            theme={theme}
          />
          </ErrorBoundary>
        ) : (
          <EditorPane
            contentOf={contentOf}
            documentBuffers={documentBuffers}
            reading={readerIntegration}
            tabs={tabs}
            layout={layout}
            theme={theme}
            tabSize={tabSize}
            rainbowBrackets={rainbowBrackets}
            saveStatus={saveStatus}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onReopenClosedTab={reopenClosedTab}
            onClosePane={closePaneAndTabs}
            onMoveTab={moveTab}
            onSplitTabToPane={splitTabToPane}
            onResizePanes={resizePanes}
            onFocusPane={focusPane}
            onNewNote={handleNewNote}
            onPaneBack={paneBack}
            onPaneForward={paneForward}
            onToggleMode={toggleTabMode}
            onContentChange={updateTabContent}
            onNativeCanvasReady={onNativeCanvasReady}
            nativeCanvasHost={nativeCanvasHost}
            attachCanvasSession={attachNativeCanvasSession}
            onDiskAction={handleDiskAction}
            onAnnotationPreflight={onAnnotationPreflight}
            onPreparePdfPrint={preparePdfPrint}
            onRotatePdf={rotatePdf}
            onRetryRead={retryUnreadTab}
            onOpenNotebookSource={handleOpenNotebookSource}
            onExportNotebook={handleExportNotebook}
            onUnsignedPdfCopy={handleUnsignedPdfCopy}
            onOpenNote={openNoteByName}
            markdownSessions={markdownSessions}
            getWikiLinkTargets={getWikiLinkTargets}
            onNotify={notify}
            onConfirm={ask}
            graph={graph}
            onOpenNode={handleOpenNode}
            revealRequest={pendingReveal}
            onRevealHandled={handleRevealHandled}
          />
        )}
        {/* After the main view and outside its ternary, so the graph view never
            unmounts it; the shells themselves live in a module store and
            outlive the dock either way. */}
        <ErrorBoundary label="The terminal" fallback={(error, retry) => terminalOpen && <div className="part-failure-host is-dock"><PartFailureBox error={error} retry={retry} what="the terminal" /></div>}>
          <TerminalDock open={terminalOpen} takeFocus={terminalOpenedByUser} onHide={hideTerminal} />
        </ErrorBoundary>
      </div>
      {agentPanelOpen && (
        <>
          <div className="workspace-resize-handle agent" onMouseDown={startAgentResize} />
          <div
            className="workspace-agent-panel"
            style={{ width: agentPanelWidth }}
          >
            <ErrorBoundary label="The agent panel" fallback={panelFailure('the agent panel')}>
              <AgentPanel fallback={<div className="workspace-agent-loading">Loading…</div>} vault={agentVault} theme={theme} getHostDeps={getAgentHostDeps} takeFocus={agentOpenedByReader} onClose={closeAgentPanel} />
            </ErrorBoundary>
          </div>
        </>
      )}
      {showSettings && (
        <ErrorBoundary label="Settings" fallback={modalFailure('Settings', closeSettings)}>
        <SettingsPanel
          editorFontSize={editorFontSize}
          codeFontSize={codeFontSize}
          rainbowBrackets={rainbowBrackets}
          vaultId={settingsVaultId}
          treeFontSize={treeFontSize}
          editorPadding={editorPadding}
          tabSize={tabSize}
          fontFamily={fontFamily}
          caretStyle={caretStyle}
          caretThickness={caretThickness}
          smoothCaret={smoothCaret}
          caretSpeed={caretSpeed}
          accentColor={accentColor}
          codeBlockColor={codeBlockColor}
          recentVaultLimit={recentVaultLimit}
          showVaultInTitle={showVaultInTitle}
          onEditorFontSizeChange={setEditorFontSize}
          onCodeFontSizeChange={setCodeFontSize}
          onRainbowBracketsChange={setRainbowBrackets}
          onTreeFontSizeChange={setTreeFontSize}
          onEditorPaddingChange={setEditorPadding}
          onTabSizeChange={setTabSize}
          onFontFamilyChange={setFontFamily}
          onCaretStyleChange={setCaretStyle}
          onCaretThicknessChange={setCaretThickness}
          onSmoothCaretChange={setSmoothCaret}
          onCaretSpeedChange={setCaretSpeed}
          onAccentColorChange={setAccentColor}
          onCodeBlockColorChange={setCodeBlockColor}
          onRecentVaultLimitChange={setRecentVaultLimit}
          onShowVaultInTitleChange={setShowVaultInTitle}
          onResetDefaults={handleResetDefaults}
          onClose={closeSettings}
        />
        </ErrorBoundary>
      )}
      {/* Over the workspace like Settings, and before ConfirmDialog for the
          same reason the menu is: nearly everything this panel does raises a
          question, and the dialog has to cover the panel that asked it. */}
      {showTrash && (
        <ErrorBoundary label="The Trash" fallback={modalFailure('the Trash', closeTrash)}>
        <TrashPanel
          onClose={closeTrash}
          onCrawl={listTrash}
          onCopy={handleTrashCopy}
          onRestore={handleTrashRestore}
          onDelete={handleTrashDelete}
          onEmpty={handleTrashEmpty}
          onReadText={handleTrashReadText}
          onReadFile={handleTrashReadFile}
        />
        </ErrorBoundary>
      )}
      {/* Before the dialog, so ConfirmDialog still covers it: a menu row can
          raise a question (Move to Trash), and the menu closes first anyway. */}
      {contextMenu && <ContextMenu request={contextMenu} onClose={closeContextMenu} />}
      {/* Last, so it sits over the settings panel as well as the workspace —
          and outside the editor, because the questions it asks are the file
          tree's (which is visible in the graph view too). */}
      {dialogHost}
      <SaveNotices>{updateNotice}</SaveNotices>
    </div>
  );
}
