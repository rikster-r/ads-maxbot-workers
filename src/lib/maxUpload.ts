import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bot } from '../bot.js';

// The SDK's upload helper picks a different code path per source type, and
// each media kind is only reliable on one of them (opposite of each other):
//  - image: a file-path source falls back to a hand-rolled multipart body
//    that isn't a real Blob, so MAX silently receives no file at all — a
//    raw Buffer instead goes through the SDK's Blob-based multipart path,
//    which works.
//  - video: a raw Buffer forces a single-shot multipart upload whose
//    response MAX's video CDN answers with a legacy `<retval>1</retval>`
//    plaintext body — but the SDK always does res.json() on it, so it
//    throws. A file-path source instead routes through the chunked
//    (Content-Range) path, which reads the response as plain text.
export async function uploadBufferToMax(kind: 'image' | 'video', data: Buffer) {
  if (kind === 'image') {
    return bot.api.uploadImage({ source: data });
  }

  const tempPath = path.join(os.tmpdir(), `max-video-${randomUUID()}.mp4`);
  await writeFile(tempPath, data);
  try {
    return await bot.api.uploadVideo({ source: tempPath });
  } finally {
    await rm(tempPath, { force: true });
  }
}
