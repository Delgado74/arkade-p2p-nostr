/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARK_OPERATOR?: string;
  readonly VITE_RELAYS?: string;
  readonly VITE_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
