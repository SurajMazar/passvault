import { productionUrlFrom } from '../background/servers';

/**
 * Build-time configuration (Vite inlines these; nothing is fetched at runtime).
 * The production server is optional: without it the extension starts on local
 * development, and the user can enter any server address in the popup.
 */
const env = import.meta.env ?? ({} as ImportMetaEnv);
export const PRODUCTION_API_URL: string | null = productionUrlFrom(env.VITE_PRODUCTION_URL || env.VITE_API_URL);
export const PRODUCTION_WEB_URL: string | null = PRODUCTION_API_URL ? (productionUrlFrom(env.VITE_WEB_URL) ?? PRODUCTION_API_URL) : null;
