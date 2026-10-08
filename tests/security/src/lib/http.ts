/**
 * Minimal API client used by every black-box suite. Every request and
 * response (headers + body) is appended to `traffic`, which the leakage suite
 * scans for canaries. 429s are retried after Retry-After unless `noRetry`.
 */
export interface Exchange {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export const traffic: Exchange[] = [];

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export interface CallOpts {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  noRetry?: boolean;
  query?: Record<string, string | number | undefined>;
}

export class Api {
  constructor(readonly base: string) {}

  async call<T = any>(method: string, path: string, opts: CallOpts = {}): Promise<ApiResponse<T>> {
    const qs = opts.query
      ? `?${new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`
      : '';
    const url = `${this.base}/api/v1${path}${qs}`;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers['content-type'] ??= 'application/json';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await fetch(url, { method, headers, body });
      } catch (e) {
        // Transient connection errors (e.g. right after the stack started): retry a few times.
        if (attempt < 4) {
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
      const text = await r.text();
      traffic.push({
        method,
        url,
        requestHeaders: headers,
        requestBody: body ?? '',
        status: r.status,
        responseHeaders: Object.fromEntries(r.headers.entries()),
        responseBody: text,
      });
      if (r.status === 429 && !opts.noRetry && attempt < 8) {
        const wait = Math.min(65, Number(r.headers.get('retry-after')) || 10);
        await new Promise((res) => setTimeout(res, wait * 1000 + 250));
        continue;
      }
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      return { status: r.status, body: parsed as T, text, headers: r.headers };
    }
  }

  get<T = any>(path: string, opts: CallOpts = {}) {
    return this.call<T>('GET', path, opts);
  }
  post<T = any>(path: string, body?: unknown, opts: CallOpts = {}) {
    return this.call<T>('POST', path, { ...opts, body: body ?? {} });
  }
  put<T = any>(path: string, body?: unknown, opts: CallOpts = {}) {
    return this.call<T>('PUT', path, { ...opts, body });
  }
  patch<T = any>(path: string, body?: unknown, opts: CallOpts = {}) {
    return this.call<T>('PATCH', path, { ...opts, body });
  }
  del<T = any>(path: string, body?: unknown, opts: CallOpts = {}) {
    return this.call<T>('DELETE', path, { ...opts, body });
  }
}

export const errCode = (r: ApiResponse) => (r.body && typeof r.body === 'object' ? (r.body as { error?: { code?: string } }).error?.code : undefined);
export const brief = (r: ApiResponse) => `${r.status} ${errCode(r) ?? ''}`.trim();
