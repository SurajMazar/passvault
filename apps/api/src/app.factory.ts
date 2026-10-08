import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config/config';
import { AppModule, type AppModuleOptions } from './app.module';
import { errorBody } from './common/exception.filter';

export const API_PREFIX = 'api/v1';

/** Build and configure the Nest application (shared by main.ts and the e2e tests). */
export async function createApp(cfg: AppConfig, opts: AppModuleOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg, opts), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  // Request id first, so every log line and error body carries it.
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.enableCors({
    origin: cfg.CORS_ORIGINS.length ? cfg.CORS_ORIGINS : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  });
  // JSON body parser with our own error envelope (malformed JSON / too large).
  const json = express.json({ limit: cfg.BODY_LIMIT });
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    json(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { status?: number; type?: string };
      const status = e.status === 413 ? 413 : 400;
      res
        .status(status)
        .json(errorBody(status, 'validation_failed', status === 413 ? 'Request body too large' : 'Malformed JSON body', req.id));
    });
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
