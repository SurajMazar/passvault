/** Build-time configuration (Vite inlines these; nothing is fetched at runtime). */
export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) || 'http://localhost:3000';
export const WEB_URL: string = (import.meta.env?.VITE_WEB_URL as string | undefined) || 'http://localhost:5173';
