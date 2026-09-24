import { useI18n } from '../../app/i18n'
import type { InterpretationStatus } from '../../api/contracts'
import { Badge } from '../../design-system'

const statusPresentation: Record<InterpretationStatus, { label: string; tone: 'neutral' | 'danger' | 'success' }> = {
  created: { label: 'Ready', tone: 'neutral' },
  live: { label: 'Live', tone: 'danger' },
  completed: { label: 'Saved', tone: 'success' },
  failed: { label: 'Interrupted', tone: 'danger' },
}

export function StatusBadge({ status, archivedAt }: { status: InterpretationStatus; archivedAt?: string | null }) {
  const {t}=useI18n()

  if (archivedAt) return <Badge tone="neutral">{t("Archived")}</Badge>
  const { label, tone } = statusPresentation[status]
  return <Badge tone={tone} dot={status === 'live'}>{t(label)}</Badge>
}
