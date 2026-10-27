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

/** A file name safe to store and show: no path, no control or direction-changing characters, not too long. */
export function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f"\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) || 'attachment';
}

/** Most pixels an image may have: bigger ones could exhaust a phone's memory when shown. */
const MAX_PIXELS = 50_000_000;

/** An image's width and height from its header, where that's simple to read (not JPEG); otherwise null. */
export function imageSize(data: Uint8Array, type: AttachmentType): [number, number] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let size: [number, number] | null = null;
  if (type === 'image/png' && data.length >= 24) size = [view.getUint32(16), view.getUint32(20)];
  if (type === 'image/gif' && data.length >= 10) size = [view.getUint16(6, true), view.getUint16(8, true)];
  // WebP extended format: the canvas size, 24-bit, minus one.
  if (type === 'image/webp' && data.length >= 30 && String.fromCharCode(...data.subarray(12, 16)) === 'VP8X') {
    const u24 = (at: number) => data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
    size = [u24(24) + 1, u24(27) + 1];
  }
  return size;
}

/** Why the image is too big to show safely, or null. */
export function oversizedImage(data: Uint8Array, type: AttachmentType): string | null {
  const size = imageSize(data, type);
  if (size && size[0] * size[1] > MAX_PIXELS) {
    return `The image is ${size[0]}×${size[1]}: at most ${MAX_PIXELS / 1_000_000} megapixels, so phones can show it`;
  }
  return null;
}

const mb = (bytes: number) => Math.floor(bytes / 1024 / 1024);

/**
 * The type of a file to attach, checked the same way for every upload (POST /api/attachments and
 * the upload_attachment tool): at most `maxBytes`, not empty, a type the app renders safely, and
 * an image small enough for a phone. Throws a ValidationError saying what's wrong.
 */
export function checkAttachment(data: Uint8Array, name: string, maxBytes: number): AttachmentType {
  if (data.length > maxBytes) throw new ValidationError(`Attachments are limited to ${mb(maxBytes)} MB`);
  if (!data.length) throw new ValidationError('The file is empty');
  const type = sniff(data, name);
  if (!type) throw new ValidationError('Attach Markdown (.md) or text (.txt) files, or PNG, JPEG, WebP or GIF images');
  const tooBig = oversizedImage(data, type);
  if (tooBig) throw new ValidationError(tooBig);
  return type;
}

/** Reads the request body, refusing it once it passes `max` bytes. */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new ValidationError(`Attachments are limited to ${mb(max)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The `file` field of a multipart/form-data upload (`curl -F file=@plan.md`), at most `maxBytes`.
 * Only that one field is read; anything else in the form is ignored.
 */
export async function readUpload(req: Request, maxBytes: number): Promise<{ name: string; data: Uint8Array }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? '') || !boundary) {
    throw new ValidationError('Upload the file as multipart/form-data, e.g. curl -F file=@plan.md');
  }
  // Room for the form's own headers around the file.
  const limit = maxBytes + 16 * 1024;
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    throw new ValidationError(`Attachments are limited to ${mb(maxBytes)} MB`);
  }
  const body = await readBody(req, limit);
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
      if (data.length > maxBytes) throw new ValidationError(`Attachments are limited to ${mb(maxBytes)} MB`);
      if (!data.length) throw new ValidationError('The file is empty');
      // curl escapes quotes in file names as \".
      const name = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1]?.replace(/\\(.)/g, '$1') ?? 'attachment';
      return { name: cleanName(name), data };
    }
    at = next + 2;
  }
  throw new ValidationError('No file in the upload: send it in the `file` field (curl -F file=@plan.md)');
}
