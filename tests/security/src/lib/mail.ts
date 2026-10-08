/** Mailpit helpers (disposable stack only). */
export interface MailMessage {
  ID: string;
  Created: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

export async function messagesFor(mailpit: string, email: string): Promise<MailMessage[]> {
  const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=200`);
  const j = (await r.json()) as { messages: MailMessage[] };
  return j.messages;
}

export async function messageText(mailpit: string, id: string): Promise<{ text: string; html: string; subject: string }> {
  const m = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as { Text: string; HTML: string; Subject: string };
  return { text: m.Text, html: m.HTML, subject: m.Subject };
}

/** Waits for a new message to `email` created at/after `after` whose text matches `re`; returns group 1. */
export async function waitForMail(mailpit: string, email: string, after: number, re: RegExp, timeoutMs = 20_000): Promise<{ match: string; text: string; subject: string }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const m of await messagesFor(mailpit, email)) {
      if (Date.parse(m.Created) < after - 1500) continue;
      const t = await messageText(mailpit, m.ID);
      const hit = re.exec(t.text);
      if (hit) return { match: hit[1] ?? hit[0], text: t.text, subject: t.subject };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no mail matching ${re} for ${email}`);
}

export async function allMailText(mailpit: string): Promise<string> {
  const r = await fetch(`${mailpit}/api/v1/messages?limit=1000`);
  const j = (await r.json()) as { messages: MailMessage[] };
  const parts: string[] = [];
  for (const m of j.messages) {
    const t = await messageText(mailpit, m.ID);
    parts.push(t.subject, t.text, t.html);
  }
  return parts.join('\n');
}
