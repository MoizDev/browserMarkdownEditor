import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { FileSystemProvider } from './context/FileSystemContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FileSystemProvider>
      <App />
    </FileSystemProvider>
  </React.StrictMode>,
)
