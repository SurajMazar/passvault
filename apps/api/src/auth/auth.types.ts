import type { Device, Session, User } from '@prisma/client';

export interface AuthContext {
  session: Session;
  user: User;
  device: Device;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  /** client-generated device id of the authenticated session, if any */
  deviceId: string | null;
}
