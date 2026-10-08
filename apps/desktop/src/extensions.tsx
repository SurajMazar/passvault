import { AppWindow, KeyRound, Plug, SquareTerminal, Stethoscope, Unplug } from 'lucide-react';
import type { AppExtensions, ItemAction } from '@passvault/app';
import type { DesktopController } from './desktop/controller';
import { describeHelperError, type HelperClient } from './ipc/helper-client';
import { isSshConnection, isSshKey } from './ssh/hops';
import { AgentSettings, HelperSettings } from './ui/SettingsSections';
import { StatusBanner } from './ui/StatusBanner';
import { TerminalBadge, TerminalView } from './ui/TerminalView';

export function createExtensions(controller: DesktopController, helper: HelperClient): AppExtensions {
  const run = (fn: () => Promise<unknown>) => () => {
    fn().catch((e) => controller.notify(describeHelperError(e), 'error'));
  };
  return {
    itemActions(item) {
      const actions: ItemAction[] = [];
      if (item.payload.trashedAt) return actions;
      if (isSshConnection(item)) {
        actions.push(
          { id: 'connect', label: 'Connect', icon: <Plug className="size-3.5" />, primary: true, onSelect: run(() => controller.connect(item.id)) },
          { id: 'open-terminal', label: 'Open in Terminal.app', icon: <AppWindow />, onSelect: run(() => controller.openExternal(item.id, 'terminal')) },
          { id: 'open-iterm', label: 'Open in iTerm', icon: <AppWindow />, onSelect: run(() => controller.openExternal(item.id, 'iterm')) },
          {
            id: 'test',
            label: 'Test connection',
            icon: <Stethoscope />,
            onSelect: run(async () => {
              controller.notify(`Testing ${item.payload.title}…`, 'info');
              const r = await controller.testConnection(item.id);
              controller.notify(r.ok ? `Connection OK: ${r.message}` : `Connection test failed: ${r.message}`, r.ok ? 'success' : 'error');
            }),
          },
        );
      }
      if (isSshKey(item) && item.payload.fields.privateKey) {
        if (controller.isKeyInAgent(item.id)) {
          actions.push({ id: 'agent-remove', label: 'Remove from SSH agent', icon: <Unplug />, onSelect: run(() => controller.removeKeyFromAgent(item.id).then(() => controller.notify('Removed from the SSH agent', 'success'))) });
        } else {
          actions.push({ id: 'agent-add', label: 'Add to SSH agent', icon: <KeyRound />, onSelect: run(() => controller.addKeyToAgent(item.id)) });
        }
      }
      return actions;
    },
    extraNav: [{ id: 'terminal', label: 'Terminal', icon: <SquareTerminal />, render: () => <TerminalView />, badge: () => <TerminalBadge /> }],
    settingsSections: [
      { id: 'ssh-agent', label: 'SSH agent', render: () => <AgentSettings /> },
      { id: 'desktop', label: 'Desktop app', render: () => <HelperSettings /> },
    ],
    sshKeys: {
      generate: (o) => helper.request('ssh.keygen', o),
      inspect: (o) => helper.request('ssh.inspectKey', o),
    },
    testConnection: (item) => controller.testConnection(item.id),
    statusBanner: () => <StatusBanner />,
  };
}
