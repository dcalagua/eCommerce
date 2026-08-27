import { Button } from '@mui/material'
import { Link } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { EmptyState } from '@/shared/ui/states'

export function NotFoundPage() {
  const { t } = useI18n()
  return (
    <EmptyState
      title={t('common.notFound.title')}
      description={t('common.notFound.body')}
      action={
        <Button component={Link} to="/" variant="contained">
          {t('common.goHome')}
        </Button>
      }
    />
  )
}
