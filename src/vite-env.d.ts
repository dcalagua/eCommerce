/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_EBIM_HUB_URL?: string
  readonly VITE_EBIM_APP_SLUG?: string
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
