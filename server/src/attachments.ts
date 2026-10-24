// Files agents attach to escalations: a plan to read, a UI preview to look at. Only types the app
// renders safely are accepted, recognised by their content rather than their name or declared type.
import type { Request } from 'express';
import { ValidationError } from './store.ts';
import type { AttachmentType } from './types.ts';

const startsWith = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);

/**
 * The attachment's type from its bytes: PNG, JPEG, GIF or WebP images, or UTF-8 text named .md
 * (Markdown) or .txt. Anything else (SVG, HTML, PDF, binaries) is refused.
 */
export function sniff(data: Uint8Array, name: string): AttachmentType | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  const ext = name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (ext !== 'md' && ext !== 'markdown' && ext !== 'txt') return null;
  if (data.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  return ext === 'txt' ? 'text/plain' : 'text/markdown';
}

/** A file name safe to store and show: no path, no control characters, not too long. */
export function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 120) || 'attachment';
}

/** Reads the request body, refusing it once it passes `max` bytes. */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new ValidationError(`Attachments are limited to ${Math.floor(max / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The `file` field of a multipart/form-data upload (`curl -F file=@plan.md`), at most `maxBytes`.
 * Only that one field is read; anything else in the form is ignored.
 */
export async function readUpload(req: Request, maxBytes: number): Promise<{ name: string; data: Uint8Array }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? '') || !boundary) {
    throw new ValidationError('Upload the file as multipart/form-data, e.g. curl -F file=@plan.md');
  }
  // Room for the form's own headers around the file.
  const body = await readBody(req, maxBytes + 16 * 1024);
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const headStart = at + delimiter.length + 2; // past the CRLF
    const headEnd = body.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) break;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headEnd);
    if (next === -1) break;
    const head = body.subarray(headStart, headEnd).toString('utf8');
    const disposition = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
    if (/\bname="file"/i.test(disposition)) {
      const data = body.subarray(headEnd + 4, next);
      if (data.length > maxBytes) throw new ValidationError(`Attachments are limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      if (!data.length) throw new ValidationError('The file is empty');
      const name = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? 'attachment';
      return { name: cleanName(name), data: new Uint8Array(data) };
    }
    at = next + 2;
  }
  throw new ValidationError('No file in the upload: send it in the `file` field (curl -F file=@plan.md)');
}
