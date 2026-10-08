import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorBody, ApiErrorCode } from '@passvault/types';
import type { Request, Response } from 'express';
import { ApiException } from './errors';

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'validation_failed',
  415: 'validation_failed',
  429: 'rate_limited',
};

/** Describe an error for logs WITHOUT its message when it may carry request data (e.g. Prisma). */
export function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as Error & { code?: unknown };
  const isPrisma = e.name.startsWith('Prisma');
  return {
    type: e.name,
    errCode: typeof e.code === 'string' ? e.code : undefined,
    // Prisma messages can echo query arguments (ciphertext, hashes) — never log them.
    message: isPrisma ? undefined : e.message.slice(0, 300),
    stack: e.stack?.split('\n').slice(1, 8).join('\n'),
  };
}

export function errorBody(status: number, code: ApiErrorCode, message: string, requestId: string | undefined, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details }, requestId };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = req.id;
    if (res.headersSent) return;

    let status = 500;
    let code: ApiErrorCode = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof ApiException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      code = 'rate_limited';
      message = 'Too many requests, please try again later';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_CODES[status] ?? (status >= 500 ? 'internal_error' : 'validation_failed');
      message = status === 404 ? 'Not found' : status === 413 ? 'Request body too large' : exception.message;
    }

    if (status >= 500) {
      this.logger.error({ requestId, err: describeError(exception) }, 'unhandled error');
    }
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json(errorBody(status, code, message, requestId, details));
  }
}
