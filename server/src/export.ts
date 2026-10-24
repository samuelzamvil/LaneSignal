import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import { EXPORT_COLUMNS, EXPORT_DATASETS, type ExportDataset, type ExportFilter, type Store } from './store.ts';

/**
 * RFC 4180 CSV. Text that a spreadsheet would treat as a formula (= + - @,
 * tab, CR) gets a leading apostrophe, since agent-supplied text ends up here.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let text = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

export function datasetCsv(store: Store, dataset: ExportDataset, filter: ExportFilter) {
  return toCsv(store.exportRows(dataset, filter), [...EXPORT_COLUMNS[dataset]]);
}

const PAGE = 1000;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Walks a dataset in keyset pages, yielding to the event loop between pages so
 * a large export doesn't stall SSE streams, long-polls and other requests.
 */
async function eachPage(
  store: Store,
  dataset: ExportDataset,
  filter: ExportFilter,
  onRows: (rows: Record<string, unknown>[]) => void,
) {
  let after = 0;
  for (;;) {
    const { rows, last } = store.exportPage(dataset, filter, after, PAGE);
    onRows(rows);
    if (last === null) return;
    after = last;
    await yieldToEventLoop();
  }
}

/** The dataset as CSV, built page by page. */
export async function datasetCsvAsync(store: Store, dataset: ExportDataset, filter: ExportFilter) {
  const columns = [...EXPORT_COLUMNS[dataset]];
  const parts: string[] = [toCsv([], columns)];
  await eachPage(store, dataset, filter, (rows) => {
    if (rows.length) parts.push(toCsv(rows, columns).slice(parts[0].length));
  });
  return parts.join('');
}

/** The dataset as an array, built page by page. */
export async function datasetRowsAsync(store: Store, dataset: ExportDataset, filter: ExportFilter) {
  const out: Record<string, unknown>[] = [];
  await eachPage(store, dataset, filter, (rows) => out.push(...rows));
  return out;
}

const deflate = promisify(deflateRaw);

/** All datasets as CSVs plus a README, zipped. Compression runs off the event loop. */
export async function exportZip(
  store: Store,
  filter: ExportFilter,
  generatedAt: Date,
  datasets: readonly ExportDataset[] = EXPORT_DATASETS,
) {
  const files: { name: string; data: Buffer }[] = [];
  for (const d of datasets) {
    files.push({ name: `${d}.csv`, data: Buffer.from(await datasetCsvAsync(store, d, filter), 'utf8') });
  }
  files.push({
    name: 'README.txt',
    data: Buffer.from(
      [
        `LaneSignal export, generated ${generatedAt.toISOString()}`,
        filter.from || filter.to
          ? `Escalations, positions, messages and events from ${filter.from ?? 'the start'} to ${filter.to ?? 'now'} (lanes and groups complete).`
          : 'All escalations, positions, messages and events.',
        filter.laneId ? `Only lane "${filter.laneId}" (groups complete).` : 'Includes archived lanes and groups.',
        '',
        'escalations.csv    one row per escalation, with decision timings and position counts',
        'positions.csv      one row per agent position on an escalation',
        'messages.csv       the conversations on escalations (Other answers and agent replies)',
        'lane_messages.csv  the conversations on lanes (the agent\'s notices and the owner\'s notes)',
        'lanes.csv          every lane, including archived ones (archived_at set)',
        'groups.csv         every group (epic/train/overseer), including archived ones',
        'events.csv         lane history: status changes, escalation steps, recent activity text, conversation messages',
        ...(datasets.includes('requirements') ? ['requirements.csv   the owner\'s product decisions, including superseded and retired ones'] : []),
        '',
        'Timestamps are UTC ISO 8601. Column reference: docs/export.md in the LaneSignal repository.',
        '',
      ].join('\n'),
      'utf8',
    ),
  });
  return zipFiles(files, generatedAt);
}

/** Zips files (deflated off the event loop). */
export async function zipFiles(files: { name: string; data: Buffer }[], date: Date): Promise<Buffer> {
  return zip(await Promise.all(files.map(async (f) => ({ ...f, compressed: await deflate(f.data) }))), date);
}

/** Minimal ZIP writer (deflate), enough for a handful of text files. */
function zip(files: { name: string; data: Buffer; compressed: Buffer }[], date: Date): Buffer {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const compressed = f.compressed;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
