import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { FileSystemProvider } from './context/FileSystemContext'
import './index.css'
import { installTooltips } from './utils/tooltip'
import { installPenPriority } from './utils/penPriority'
import { installStorageRecovery, restoreStorageBeforeRender } from './utils/storage'
import { ErrorBoundary, RootFailure } from './components/ErrorBoundary'
import { listenForPreloadErrors } from './platform/chunkLoad'

installPenPriority()
installTooltips()
listenForPreloadErrors()

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary label="The app" fallback={error => <RootFailure error={error} />}>
        <FileSystemProvider><App /></FileSystemProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  )
  installStorageRecovery()
}

const recovery = restoreStorageBeforeRender()
if (recovery) void recovery.then(restored => {
  if (restored) location.reload()
  else mount()
}, mount)
else mount()
