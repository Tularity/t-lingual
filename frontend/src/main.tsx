import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './app/auth'
import { RouterProvider } from './app/router'
import { ThemeProvider, ToastProvider } from './design-system'
import './design-system/global.css'
import './main.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider>
        <ToastProvider>
          <AuthProvider><App /></AuthProvider>
        </ToastProvider>
      </RouterProvider>
    </ThemeProvider>
  </StrictMode>,
)
