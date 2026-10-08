import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from '../config/config';
import { ipPrefix } from '../common/util';

/**
 * Logging policy (see docs/OPERATIONS.md "Redaction"):
 *  - request logs contain method, path WITHOUT query string, status, duration,
 *    request id and the client IP truncated to /24 (IPv4) or /48 (IPv6);
 *  - never request/response bodies, headers (Authorization, cookies), tokens,
 *    authKey, MFA/recovery codes, ciphertext, or full email addresses.
 */
export const REDACT_PATHS = [
  'authorization',
  '*.authorization',
  'headers',
  '*.headers',
  'body',
  '*.body',
  'authKey',
  '*.authKey',
  'recoveryAuthKey',
  '*.recoveryAuthKey',
  'token',
  '*.token',
  'mfaToken',
  '*.mfaToken',
  'trustedDeviceToken',
  '*.trustedDeviceToken',
  'recoveryToken',
  'registrationToken',
  '*.registrationToken',
  '*.recoveryToken',
  'code',
  '*.code',
  'recoveryCode',
  '*.recoveryCode',
  'recoveryCodes',
  '*.recoveryCodes',
  'secret',
  '*.secret',
  'password',
  '*.password',
  'encryptedPayload',
  '*.encryptedPayload',
  'encryptedKey',
  '*.encryptedKey',
  'email',
  '*.email',
];

export function buildLoggerParams(cfg: AppConfig, stream?: DestinationStream): Params {
  const options = {
    level: cfg.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? randomUUID(),
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    serializers: {
      req: (req: { id?: string; method?: string; url?: string; remoteAddress?: string; raw?: { ip?: string } }) => ({
        id: req.id,
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        ip: ipPrefix(req.raw?.ip ?? req.remoteAddress),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error) => ({ type: err?.name, stack: err?.stack?.split('\n').slice(1, 6).join('\n') }),
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
    quietReqLogger: true,
  };
  return {
    pinoHttp: stream ? [options, stream] : options,
  } as Params;
}
