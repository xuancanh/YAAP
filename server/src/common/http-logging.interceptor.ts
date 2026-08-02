/**
 * HttpLoggingInterceptor — one log line per request: method, path, status,
 * duration. Wired globally in app.module.ts:
 *
 *   providers: [..., { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor }]
 *
 * (APP_INTERCEPTOR from @nestjs/core.)
 */
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';
import type { Request, Response } from 'express';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    const log = (status: number) =>
      this.logger.log(`${req.method} ${req.originalUrl} ${status} ${Date.now() - start}ms`);
    return next.handle().pipe(
      tap({
        next: () => log(context.switchToHttp().getResponse<Response>().statusCode),
        // Errors bypass the response object above, so derive the status from
        // the exception (non-HTTP exceptions become Nest's 500).
        error: (err: unknown) => log(err instanceof HttpException ? err.getStatus() : 500),
      }),
    );
  }
}
