import { Alert, Snackbar } from '@mui/material'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { FeedbackCtx, type FeedbackSeverity } from './feedback-context'

interface Toast {
  /** Cambia en cada aviso: fuerza el remontaje y reinicia el temporizador. */
  key: number
  message: string
  severity: FeedbackSeverity
}

/**
 * Avisos efímeros de la app (guardado, publicado, borrado, error de escritura).
 *
 * Uno a la vez y con `role="alert"` en el error: un guardado que no confirma
 * deja al usuario pulsando dos veces, y una pila de snackbars tapa la pantalla
 * en móvil. El error de una mutación se dice aquí *además* de dejar el
 * formulario abierto con los datos: nunca se pierde lo que el usuario escribió.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)

  const notify = useCallback((message: string, severity: FeedbackSeverity = 'success') => {
    setToast({ key: Date.now(), message, severity })
  }, [])

  const value = useMemo(() => ({ notify }), [notify])

  return (
    <FeedbackCtx.Provider value={value}>
      {children}
      {toast && (
        <Snackbar
          key={toast.key}
          open
          autoHideDuration={toast.severity === 'error' ? 8000 : 4000}
          onClose={(_, reason) => reason !== 'clickaway' && setToast(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            severity={toast.severity}
            variant="filled"
            onClose={() => setToast(null)}
            sx={{ width: '100%' }}
          >
            {toast.message}
          </Alert>
        </Snackbar>
      )}
    </FeedbackCtx.Provider>
  )
}
