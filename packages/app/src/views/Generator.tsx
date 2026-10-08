import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { generatePassphrase, generatePassword, passphraseEntropyBits, passwordEntropyBits } from '@passvault/crypto';
import { Button, Checkbox, CopyButton, Dialog, Field, Input, Tabs } from '@passvault/ui';
import { useCopy } from '../items/ItemDetail';

export function GeneratorPanel({ onUse }: { onUse?: (v: string) => void }) {
  const copy = useCopy();
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [length, setLength] = useState(24);
  const [sets, setSets] = useState({ lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false });
  const [words, setWords] = useState(6);
  const [sep, setSep] = useState('-');
  const [cap, setCap] = useState(false);
  const [num, setNum] = useState(true);
  const [value, setValue] = useState('');
  const regen = useCallback(() => {
    try {
      setValue(mode === 'password' ? generatePassword({ length, ...sets }) : generatePassphrase({ words, separator: sep, capitalize: cap, includeNumber: num }));
    } catch {
      setValue('');
    }
  }, [mode, length, sets, words, sep, cap, num]);
  useEffect(regen, [regen]);
  const bits = mode === 'password' ? passwordEntropyBits({ length, ...sets }) : passphraseEntropyBits({ words, includeNumber: num });
  return (
    <div className="space-y-4">
      <Tabs label="Generator type" value={mode} onChange={setMode} tabs={[{ id: 'password', label: 'Password' }, { id: 'passphrase', label: 'Passphrase' }]} />
      <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface-2 p-3">
        <output className="flex-1 font-mono text-base break-all" aria-live="polite">
          {value}
        </output>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={regen} aria-label="Regenerate" />
        <CopyButton onCopy={() => copy(value)} />
      </div>
      <p className="text-xs text-fg-subtle">≈ {bits} bits of entropy · generated locally with a cryptographically secure RNG</p>
      {mode === 'password' ? (
        <>
          <Field label={`Length: ${length}`}>{(id) => <input id={id} type="range" min={8} max={128} value={length} onChange={(e) => setLength(Number(e.target.value))} className="w-full accent-[var(--pv-accent)]" />}</Field>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['lowercase', 'a–z'],
                ['uppercase', 'A–Z'],
                ['digits', '0–9'],
                ['symbols', '!@#$…'],
                ['avoidAmbiguous', 'Avoid ambiguous (Il1O0)'],
              ] as const
            ).map(([k, l]) => (
              <Checkbox key={k} checked={sets[k]} onChange={(v) => setSets({ ...sets, [k]: v })} label={l} />
            ))}
          </div>
        </>
      ) : (
        <>
          <Field label={`Words: ${words}`}>{(id) => <input id={id} type="range" min={3} max={12} value={words} onChange={(e) => setWords(Number(e.target.value))} className="w-full accent-[var(--pv-accent)]" />}</Field>
          <div className="flex flex-wrap items-center gap-4">
            <Field label="Separator">{(id) => <Input id={id} className="!w-16" maxLength={3} value={sep} onChange={(e) => setSep(e.target.value)} />}</Field>
            <Checkbox checked={cap} onChange={setCap} label="Capitalize" />
            <Checkbox checked={num} onChange={setNum} label="Include a number" />
          </div>
        </>
      )}
      {onUse && (
        <Button variant="primary" onClick={() => onUse(value)}>
          Use this
        </Button>
      )}
    </div>
  );
}

export function GeneratorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Password generator">
      <GeneratorPanel />
    </Dialog>
  );
}
