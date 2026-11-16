import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './security.ts';

/** Auth is enforced by the route. Support browser retries without restarting a whole installer. */
export async function sendDownload(req: FastifyRequest, reply: FastifyReply, path: string, filename: string, mime = 'application/octet-stream') {
  const info = await stat(path).catch(() => { throw new ApiError(404, 'Установщик пока недоступен.'); });
  if (!info.isFile()) throw new ApiError(404, 'Установщик пока недоступен.');
  const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  reply.header('Accept-Ranges', 'bytes').header('ETag', etag).header('Content-Disposition', `attachment; filename="${filename}"`).type(mime);
  const range = req.method !== 'HEAD' && (!req.headers['if-range'] || req.headers['if-range'] === etag) ? req.headers.range : undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, info.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
      return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${info.size}`).header('Content-Length', end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header('Content-Length', info.size);
  // Fastify's HEAD handler strips the stream body while keeping its real length.
  return reply.send(createReadStream(path));
}
