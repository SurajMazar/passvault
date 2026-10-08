import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { DesktopController, TerminalHost } from '../desktop/controller';
import { installPasteGuard, type PasteAnalysis } from './paste-guard';

/**
 * Owns one xterm.js instance per terminal tab so scrollback survives switching
 * views. Safety settings:
 *  - no clipboard addon (OSC 52 clipboard access is not possible)
 *  - allowProposedApi: false
 *  - links (plain URLs and OSC 8 hyperlinks) only via a confirm dialog → helper link.open (no shell), http(s) only
 *  - multi-line / control-character pastes need confirmation
 *  - terminal output is untrusted: it is written to xterm only, never logged or stored
 */

export interface XtermHostDeps {
  openLink(url: string): void;
  confirmPaste(a: PasteAnalysis): Promise<boolean>;
}

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  cleanup: Array<() => void>;
}

export const TERMINAL_OPTIONS: ITerminalOptions = {
  allowProposedApi: false,
  cursorBlink: true,
  fontFamily: "'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 5000,
  macOptionIsMeta: false,
  rightClickSelectsWord: true,
  theme: {
    background: '#0c1117',
    foreground: '#d6dde6',
    cursor: '#5fd4c4',
    selectionBackground: '#2a4a52',
    black: '#1b232c',
    brightBlack: '#5b6875',
  },
};

export class XtermHost implements TerminalHost {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly controller: DesktopController,
    private readonly deps: XtermHostDeps,
  ) {}

  private create(connId: string): Entry {
    const el = document.createElement('div');
    el.className = 'pv-xterm h-full w-full';
    const term = new Terminal({
      ...TERMINAL_OPTIONS,
      // OSC 8 hyperlinks: never use xterm's default (window.confirm + window.open).
      linkHandler: { activate: (_e, uri) => this.deps.openLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => this.deps.openLink(uri)));
    // ⌘T / ⌘W are app shortcuts (handled by the Terminal view); never send them to the PTY.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && !e.altKey && !e.ctrlKey && /^[tw]$/i.test(e.key)));
    term.open(el);
    const cleanup: Array<() => void> = [];
    const d1 = term.onData((d) => this.controller.write(connId, d));
    const d2 = term.onBinary((d) => this.controller.write(connId, d, true));
    cleanup.push(() => d1.dispose(), () => d2.dispose());
    cleanup.push(
      installPasteGuard(el, {
        confirm: (a) => this.deps.confirmPaste(a),
        paste: (text) => term.paste(text),
      }),
    );
    cleanup.push(this.controller.registerSink(connId, { write: (b) => term.write(b) }));
    const entry = { term, fit, el, cleanup };
    this.entries.set(connId, entry);
    return entry;
  }

  /** Attaches (creating on first use) the terminal into `container`; returns a detach function. */
  attach(connId: string, container: HTMLElement): () => void {
    const entry = this.entries.get(connId) ?? this.create(connId);
    container.appendChild(entry.el);
    const doFit = () => {
      if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        entry.fit.fit();
      } catch {
        return;
      }
      this.controller.resize(connId, entry.term.cols, entry.term.rows);
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(container);
    requestAnimationFrame(doFit);
    return () => {
      ro.disconnect();
      if (entry.el.parentElement === container) container.removeChild(entry.el);
    };
  }

  focus(connId: string) {
    this.entries.get(connId)?.term.focus();
  }

  writeNotice(connId: string, text: string) {
    // eslint-disable-next-line no-control-regex -- strips control characters so notice text cannot inject terminal escapes
    this.entries.get(connId)?.term.write(`\r\n\x1b[2m${text.replace(/[\x00-\x1f\x7f]/g, '')}\x1b[0m\r\n`);
  }

  dispose(connId: string) {
    const e = this.entries.get(connId);
    if (!e) return;
    this.entries.delete(connId);
    e.cleanup.forEach((f) => f());
    e.term.dispose();
    e.el.remove();
  }

  disposeAll() {
    for (const id of [...this.entries.keys()]) this.dispose(id);
  }
}
