import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

interface RouterValue {
  path: string
  search: URLSearchParams
  navigate: (to: string, options?: { replace?: boolean }) => void
}

const RouterContext = createContext<RouterValue | null>(null)

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => `${window.location.pathname}${window.location.search}`)
  useEffect(() => {
    const onPopState = () => setLocation(`${window.location.pathname}${window.location.search}`)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (options?.replace) window.history.replaceState(null, '', to)
    else window.history.pushState(null, '', to)
    setLocation(`${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])
  const value = useMemo(() => {
    const parsed = new URL(location, window.location.origin)
    return { path: parsed.pathname, search: parsed.searchParams, navigate }
  }, [location, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter() {
  const context = useContext(RouterContext)
  if (!context) throw new Error('useRouter must be used within RouterProvider')
  return context
}

export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { navigate } = useRouter()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return
    event.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handleClick} {...props} />
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (!expected || !actual) return null
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual)
      } catch {
        return null
      }
    }
    else if (expected !== actual) return null
  }
  return params
}
