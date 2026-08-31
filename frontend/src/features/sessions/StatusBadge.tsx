import type { InterpretationStatus } from '../../api/contracts'
import { Badge } from '../../design-system'

const statusPresentation: Record<InterpretationStatus, { label: string; tone: 'neutral' | 'danger' | 'success' }> = {
  created: { label: 'Ready', tone: 'neutral' },
  live: { label: 'Live', tone: 'danger' },
  completed: { label: 'Complete', tone: 'success' },
  failed: { label: 'Needs attention', tone: 'danger' },
}

export function StatusBadge({ status }: { status: InterpretationStatus }) {
  const { label, tone } = statusPresentation[status]
  return <Badge tone={tone} dot={status === 'live'}>{label}</Badge>
}
