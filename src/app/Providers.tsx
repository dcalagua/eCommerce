import { QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { I18nProvider } from '@/shared/i18n/I18nProvider'
import { AppearanceProvider } from '@/theme/AppearanceProvider'
import { ErrorBoundary } from './ErrorBoundary'
import { createQueryClient } from './queryClient'

/**
 * Providers de la app. El `AppearanceProvider` de raíz usa el acento de casa;
 * el storefront lo reemplaza por el `accent_color` del tenant que resuelve.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <ErrorBoundary>
      <I18nProvider>
        <AppearanceProvider>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </AppearanceProvider>
      </I18nProvider>
    </ErrorBoundary>
  )
}
