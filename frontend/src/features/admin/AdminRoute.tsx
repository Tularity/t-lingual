import { lazy, Suspense } from 'react'
import { LoadingState } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { AccessCodesPage } from './AccessCodesPage'
import { ActivityPage } from './ActivityPage'
import { PeoplePage } from './PeoplePage'
import { ProvidersPanel } from './ProvidersPanel'
import './admin.css'

const SiteSettingsPanel = lazy(() => import('./SiteSettingsPanel').then((module) => ({ default: module.SiteSettingsPanel })))
const AdminUsagePage = lazy(() => import('../insights/AdminUsagePage').then((module) => ({ default: module.AdminUsagePage })))
const OperationsPage = lazy(() => import('../insights/OperationsPage').then((module) => ({ default: module.OperationsPage })))

/** The administration pages, in the order the sidebar lists them. */
export const adminSections = [
  { path: '/admin/codes', label: 'Access codes', icon: 'key' },
  { path: '/admin/people', label: 'People', icon: 'users' },
  { path: '/admin/usage', label: 'Usage', icon: 'chart' },
  { path: '/admin/activity', label: 'Activity', icon: 'history' },
  { path: '/admin/operations', label: 'Operations', icon: 'pulse' },
  { path: '/admin/engines', label: 'Engines', icon: 'sliders' },
  { path: '/admin/site', label: 'Site settings', icon: 'globe' },
] as const

export type AdminSection = (typeof adminSections)[number]['path']

export function AdminRoute({ path }: { path: AdminSection }) {
  const { t } = useI18n()
  if (path === '/admin/codes') return <AccessCodesPage />
  if (path === '/admin/people') return <PeoplePage />
  if (path === '/admin/activity') return <ActivityPage />
  if (path === '/admin/usage') return <Suspense fallback={<LoadingState label={t('Loading usage')} />}><AdminUsagePage /></Suspense>
  if (path === '/admin/operations') return <Suspense fallback={<LoadingState label={t('Loading readings')} />}><OperationsPage /></Suspense>
  if (path === '/admin/engines') return <div className="admin-page"><h1 className="sr-only">{t('Engines')}</h1><ProvidersPanel /></div>
  return <div className="admin-page"><h1 className="sr-only">{t('Site settings')}</h1><Suspense fallback={<LoadingState label={t('Loading site settings')} />}><SiteSettingsPanel /></Suspense></div>
}
