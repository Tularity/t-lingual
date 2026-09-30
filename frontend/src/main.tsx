import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './app/auth'
import { RouterProvider } from './app/router'
import { ThemeProvider, ToastProvider } from './design-system'
import { ErrorBoundary } from './app/ErrorBoundary'
import { I18nProvider } from './app/i18n'
import './design-system/global.css'
import './main.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider>
        <ToastProvider placement="top-end">
          <ErrorBoundary><AuthProvider><I18nProvider><App /></I18nProvider></AuthProvider></ErrorBoundary>
        </ToastProvider>
      </RouterProvider>
    </ThemeProvider>
  </StrictMode>,
)
