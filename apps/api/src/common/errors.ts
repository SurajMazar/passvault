import { HttpException } from '@nestjs/common';
import type { ApiErrorCode } from '@passvault/types';

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

/** Structured API error -> `{ error: { code, message, details? }, requestId }`. */
export class ApiException extends HttpException {
  constructor(
    status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details } satisfies ApiErrorPayload, status);
  }
}

export const E = {
  validation: (details: Array<{ path: string; message: string }>, message = 'Request validation failed') =>
    new ApiException(400, 'validation_failed', message, details),
  unauthenticated: (message = 'Authentication required') => new ApiException(401, 'unauthenticated', message),
  invalidCredentials: (status = 401) => new ApiException(status, 'invalid_credentials', 'Invalid email or credentials'),
  invalidCode: (message = 'The code is invalid or expired') => new ApiException(400, 'invalid_code', message),
  mfaInvalid: (status = 401, message = 'Invalid verification code') => new ApiException(status, 'mfa_invalid', message),
  mfaEnrollmentRequired: () => new ApiException(403, 'mfa_enrollment_required', 'Two-factor authentication must be set up first'),
  reauthRequired: () => new ApiException(403, 'reauth_required', 'Recent re-authentication is required for this action'),
  forbidden: (message = 'You do not have permission for this action') => new ApiException(403, 'forbidden', message),
  membershipExpired: () => new ApiException(403, 'membership_expired', 'Your access to this vault has expired'),
  notFound: (message = 'Not found') => new ApiException(404, 'not_found', message),
  conflict: (message: string, details?: unknown) => new ApiException(409, 'conflict', message, details),
  revisionConflict: (details: unknown, message = 'The record was changed by someone else') =>
    new ApiException(409, 'revision_conflict', message, details),
  alreadyExists: (message = 'Already exists') => new ApiException(409, 'already_exists', message),
  keyRotationRequired: () =>
    new ApiException(409, 'key_rotation_required', 'The vault key must be rotated before new members can be added'),
  registrationClosed: () => new ApiException(403, 'registration_closed', 'This server does not accept new accounts'),
  gone: (message = 'This resource was permanently deleted', details?: unknown) => new ApiException(410, 'gone', message, details),
  rateLimited: (message = 'Too many requests, please try again later') => new ApiException(429, 'rate_limited', message),
};
