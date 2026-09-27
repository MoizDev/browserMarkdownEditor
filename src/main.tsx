import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { FileSystemProvider } from './context/FileSystemContext'
import './index.css'
import { installTooltips } from './utils/tooltip'

// Once, at module scope — outside React, so StrictMode's double effects never
// install it twice (it is idempotent regardless) and no component owns it.
installTooltips()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FileSystemProvider>
      <App />
    </FileSystemProvider>
  </React.StrictMode>,
)
