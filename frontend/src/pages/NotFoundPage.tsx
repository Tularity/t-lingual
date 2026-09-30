import { useI18n } from '../app/i18n'
import { Button, Card, EmptyState } from '../design-system'
import { useRouter } from '../app/router'

export function NotFoundPage({ forbidden = false }: { forbidden?: boolean }) {
  const { navigate } = useRouter()
  const { t } = useI18n()
  return <Card className="not-found-card"><EmptyState icon={forbidden ? 'shield' : 'search'} title={forbidden ? t('This area is for administrators') : t('That page isn’t here')} description={forbidden ? t('Your account does not have permission to manage workspace access.') : t('The link may be outdated, or the page may have moved.')} action={<Button variant="primary" onClick={() => navigate('/sessions')}>{t("Back to your workspace")}</Button>} /></Card>
}
