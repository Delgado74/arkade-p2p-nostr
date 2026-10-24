import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { contractHandlers } from '@arkade-os/sdk'
import { escrowContractHandler } from './lib/escrowHandler'

try {
  contractHandlers.register(escrowContractHandler as any)
} catch {
  // ignore if already registered
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
