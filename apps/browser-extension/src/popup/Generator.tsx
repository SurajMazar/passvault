import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, Checkbox, CopyButton, Field, IconButton, Select, Tabs, useToast } from '@passvault/ui';
import { call, copyToClipboard, errorText } from './rpc';

type Kind = 'password' | 'passphrase';

/** Password/passphrase generator. Generation runs in the background (libsodium CSPRNG). */
export function Generator({ onUse }: { onUse?: (value: string) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('password');
  const [length, setLength] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [digits, setDigits] = useState(true);
  const [avoidAmbiguous, setAvoidAmbiguous] = useState(false);
  const [words, setWords] = useState(6);
  const [separator, setSeparator] = useState<'-' | '.' | '_' | ' '>('-');
  const [capitalize, setCapitalize] = useState(false);
  const [includeNumber, setIncludeNumber] = useState(false);
  const [value, setValue] = useState('');
  const [bits, setBits] = useState(0);

  const generate = useCallback(async () => {
    try {
      const r =
        kind === 'password'
          ? await call({ type: 'generator.generate', kind, length, symbols, digits, avoidAmbiguous })
          : await call({ type: 'generator.generate', kind, words, separator, capitalize, includeNumber });
      setValue(r.value);
      setBits(r.entropyBits);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }, [kind, length, symbols, digits, avoidAmbiguous, words, separator, capitalize, includeNumber, toast]);

  useEffect(() => {
    void generate();
  }, [generate]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <Tabs
        label="Generator type"
        value={kind}
        onChange={setKind}
        tabs={[
          { id: 'password', label: 'Password' },
          { id: 'passphrase', label: 'Passphrase' },
        ]}
      />
      <div className="flex items-start gap-1 rounded-lg border border-border bg-surface p-2.5">
        <output className="min-h-10 flex-1 break-all font-mono text-sm" aria-live="polite">
          {value}
        </output>
        <IconButton label="Regenerate" size="sm" onClick={() => void generate()}>
          <RefreshCw className="size-4" />
        </IconButton>
        <CopyButton
          label="Copy generated value"
          onCopy={async () => {
            const msg = await copyToClipboard(value, true);
            if (msg) toast(msg, 'success');
          }}
        />
      </div>
      <p className="text-[11px] text-fg-subtle">≈ {bits} bits of entropy</p>
      {kind === 'password' ? (
        <div className="flex flex-col gap-2.5">
          <Field label={`Length: ${length}`}>
            {(id) => <input id={id} type="range" min={8} max={64} value={length} onChange={(e) => setLength(Number(e.target.value))} className="accent-[var(--pv-accent)]" />}
          </Field>
          <Checkbox checked={digits} onChange={setDigits} label="Digits (0-9)" />
          <Checkbox checked={symbols} onChange={setSymbols} label="Symbols (!@#…)" />
          <Checkbox checked={avoidAmbiguous} onChange={setAvoidAmbiguous} label="Avoid ambiguous characters (Il1O0)" />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Field label={`Words: ${words}`}>
            {(id) => <input id={id} type="range" min={3} max={12} value={words} onChange={(e) => setWords(Number(e.target.value))} className="accent-[var(--pv-accent)]" />}
          </Field>
          <Field label="Separator">
            {(id) => (
              <Select id={id} value={separator} onChange={(e) => setSeparator(e.target.value as typeof separator)}>
                <option value="-">Hyphen (-)</option>
                <option value=".">Period (.)</option>
                <option value="_">Underscore (_)</option>
                <option value=" ">Space</option>
              </Select>
            )}
          </Field>
          <Checkbox checked={capitalize} onChange={setCapitalize} label="Capitalize words" />
          <Checkbox checked={includeNumber} onChange={setIncludeNumber} label="Include a number" />
        </div>
      )}
      {onUse && (
        <Button variant="primary" onClick={() => onUse(value)} disabled={!value}>
          Use this {kind}
        </Button>
      )}
    </div>
  );
}
