/**
 * HTTP mapping for WorkspaceFs errors, shared by the workspace and agent file
 * routes: a version conflict is a 409 carrying the current version and its
 * author (the editor's conflict banner shows them), a refused write a 403,
 * a bad path a 400, a missing file a 404.
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { FileConflictError, FilePermissionError } from './workspace-fs.service';

export function fsHttpError(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  if (err instanceof FileConflictError) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: err.message,
      path: err.path,
      expectedVersion: err.expected,
      currentVersion: err.current?.version ?? 0,
      ...(err.current ? { updatedBy: err.current.updatedBy, updatedAt: err.current.updatedAt } : {}),
    });
  }
  if (err instanceof FilePermissionError) return new ForbiddenException(err.message);
  const message = err instanceof Error ? err.message : String(err);
  if (/^file not found|^no revision/.test(message)) return new NotFoundException(message);
  if (/invalid path|empty path|invalid arguments|already exists|cannot move|was not found in|occurs \d+ times/.test(message)) {
    return new BadRequestException(message);
  }
  return err;
}

/** Run `fn`, rethrowing WorkspaceFs errors as their HTTP equivalents. */
export async function fsHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw fsHttpError(err);
  }
}
