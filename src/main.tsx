import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { FileSystemProvider } from './context/FileSystemContext'
import './index.css'
import { installTooltips } from './utils/tooltip'
import { installPenPriority } from './utils/penPriority'
import { installStorageRecovery, restoreStorageBeforeRender } from './utils/storage'

// Once, at module scope — outside React, so StrictMode's double effects never
// install it twice (it is idempotent regardless) and no component owns it.
installPenPriority()
installTooltips()

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <FileSystemProvider><App /></FileSystemProvider>
    </React.StrictMode>,
  )
  installStorageRecovery()
}

const recovery = restoreStorageBeforeRender()
if (recovery) void recovery.then(restored => {
  // Imported stores already cached their preferences. Only a real recovery
  // needs a second load; the ordinary startup keeps its static import graph.
  if (restored) location.reload()
  else mount()
})
else mount()
