import { createContext, useContext, useSyncExternalStore } from 'react';
import type { DesktopController, DesktopState } from '../desktop/controller';
import type { HelperConnection } from '../desktop/helper-connection';
import type { XtermHost } from '../terminal/xterm-host';

export interface DesktopContextValue {
  controller: DesktopController;
  connection: HelperConnection;
  xterm: XtermHost;
  /** Neutralino + client versions for the diagnostics section */
  versions: { neutralino: string; client: string; app: string };
  copyText(text: string): Promise<void>;
}

export const DesktopContext = createContext<DesktopContextValue | null>(null);

export function useDesktop(): DesktopContextValue {
  const v = useContext(DesktopContext);
  if (!v) throw new Error('DesktopContext missing');
  return v;
}

export function useDesktopState<T>(select: (s: DesktopState) => T): T {
  const { controller } = useDesktop();
  return useSyncExternalStore(controller.store.subscribe, () => select(controller.store.get()));
}
