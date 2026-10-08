import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Banner, Button, useToast } from '@passvault/ui';
import { useDesktop, useDesktopState } from './hooks';

/**
 * Rendered by the shared Shell through `AppExtensions.statusBanner`. Shows the
 * helper state and bridges desktop notices into the app's toast system while
 * the shell is mounted.
 */
export function StatusBanner() {
  const { controller, connection } = useDesktop();
  const toast = useToast();
  const helper = useDesktopState((s) => s.helper);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    controller.setToaster((m, tone) => toast(m, tone));
    return () => controller.setToaster(null);
  }, [controller, toast]);
  if (helper.state !== 'unavailable') return null;
  return (
    <Banner
      tone="danger"
      icon={<AlertTriangle className="size-4" />}
      title="The PassVault desktop helper is not running"
      action={
        <Button
          size="sm"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void connection.retry().finally(() => setBusy(false));
          }}
        >
          Retry
        </Button>
      }
    >
      {helper.reason ? `${helper.reason} ` : ''}Keychain, Touch ID, terminal sessions and the SSH agent are unavailable until it is back.
    </Banner>
  );
}
