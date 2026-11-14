import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { installTooltips } from './utils/tooltip'
import { installStorageRecovery, restoreStorageBeforeRender } from './utils/storage'

installTooltips()

async function mount() {
  // Several imported stores read preferences at module scope. Loading them
  // AFTER recovery prevents defaults being cached before IndexedDB has replied.
  const [{ default: App }, { FileSystemProvider }] = await Promise.all([
    import('./App'), import('./context/FileSystemContext'),
  ])
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <FileSystemProvider><App /></FileSystemProvider>
    </React.StrictMode>,
  )
  installStorageRecovery()
}

const restored = restoreStorageBeforeRender()
if (restored) void restored.then(mount)
else void mount()
