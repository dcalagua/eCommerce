import { QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { SessionProvider } from '@/features/auth/SessionProvider'
import { I18nProvider } from '@/shared/i18n/I18nProvider'
import { FeedbackProvider } from '@/shared/ui/FeedbackProvider'
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
          <QueryClientProvider client={queryClient}>
            {/* La sesión es global (login, guards y storefront la consultan),
                pero el contexto de tenant NO: cuelga de las rutas protegidas
                para que la vitrina pública no toque tablas del backoffice. */}
            <FeedbackProvider>
              <SessionProvider>{children}</SessionProvider>
            </FeedbackProvider>
          </QueryClientProvider>
        </AppearanceProvider>
      </I18nProvider>
    </ErrorBoundary>
  )
}
