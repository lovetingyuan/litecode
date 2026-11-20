/// <reference types="vite/client" />

declare const __GIT_HASH__: string;
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
}
