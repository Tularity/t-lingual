import { Button, Card, EmptyState } from '../design-system'
import { useRouter } from '../app/router'

export function NotFoundPage({ forbidden = false }: { forbidden?: boolean }) {
  const { navigate } = useRouter()
  return <Card className="not-found-card"><EmptyState icon={forbidden ? 'shield' : 'search'} title={forbidden ? 'This area is for administrators' : 'That page isn’t here'} description={forbidden ? 'Your account does not have permission to manage workspace access.' : 'The link may be outdated, or the page may have moved.'} action={<Button variant="primary" onClick={() => navigate('/sessions')}>Return to sessions</Button>} /></Card>
}
