import type { CustomField } from '@passvault/types';

/** A login-form field beside username and password, e.g. AWS's "Account ID or alias". */
export interface FormExtra {
  label: string;
  value: string;
}

/** New text custom fields for a login saved from a page. */
export function extrasToCustomFields(extras: FormExtra[]): CustomField[] {
  return extras
    .filter((x) => x.label.trim() && x.value.trim())
    .slice(0, 5)
    .map((x) => ({ id: crypto.randomUUID(), label: x.label.trim().slice(0, 100), type: 'text' as const, value: x.value.trim().slice(0, 500) }));
}

/** Updates custom fields with the same label (case-insensitive) and adds the rest. */
export function mergeExtras(fields: CustomField[], extras: FormExtra[]): CustomField[] {
  const out = [...fields];
  for (const cf of extrasToCustomFields(extras)) {
    const i = out.findIndex((f) => f.label.trim().toLowerCase() === cf.label.toLowerCase());
    if (i >= 0) {
      if (out[i]!.type !== 'secret') out[i] = { ...out[i]!, value: cf.value };
    } else if (out.length < 50) out.push(cf);
  }
  return out;
}
