import { crc32, deflateRawSync } from 'node:zlib';
import { EXPORT_DATASETS, type ExportDataset, type ExportFilter, type Store } from './store.ts';

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

/** Column order for empty exports, so every CSV always has a header row. */
const columnsFor = (dataset: ExportDataset, rows: Record<string, unknown>[]) =>
  rows[0] ? Object.keys(rows[0]) : EMPTY_COLUMNS[dataset];

const EMPTY_COLUMNS: Record<ExportDataset, string[]> = {
  escalations: ['id', 'lane_id', 'lane_name', 'group_id', 'group_name', 'question', 'state', 'created_at', 'decided_at', 'decision'],
  positions: ['escalation_id', 'lane_id', 'question', 'agent', 'stance', 'note', 'at'],
  lanes: ['id', 'name', 'group_id', 'group_name', 'status', 'created_at', 'updated_at', 'archived_at'],
  groups: ['id', 'name', 'ticket', 'created_at', 'updated_at', 'archived_at'],
  events: ['id', 'lane_id', 'at', 'kind', 'message', 'actor'],
};

export function datasetCsv(store: Store, dataset: ExportDataset, filter: ExportFilter) {
  const rows = store.exportRows(dataset, filter);
  return toCsv(rows, columnsFor(dataset, rows));
}

/** All datasets as CSVs plus a README, zipped. */
export function exportZip(store: Store, filter: ExportFilter, generatedAt: Date) {
  const files: { name: string; data: Buffer }[] = EXPORT_DATASETS.map((d) => ({
    name: `${d}.csv`,
    data: Buffer.from(datasetCsv(store, d, filter), 'utf8'),
  }));
  files.push({
    name: 'README.txt',
    data: Buffer.from(
      [
        `LaneSignal export, generated ${generatedAt.toISOString()}`,
        filter.from || filter.to ? `Escalations, positions and events from ${filter.from ?? 'the start'} to ${filter.to ?? 'now'}.` : 'Everything, including archived lanes and groups.',
        '',
        'escalations.csv  one row per escalation, with decision timings and position counts',
        'positions.csv    one row per agent position on an escalation',
        'lanes.csv        every lane, including archived ones (archived_at set)',
        'groups.csv       every group (epic/train/overseer), including archived ones',
        'events.csv       lane history: status changes, escalation steps, recent activity text',
        '',
        'Timestamps are UTC ISO 8601. Column reference: docs/export.md in the LaneSignal repository.',
        '',
      ].join('\n'),
      'utf8',
    ),
  });
  return zip(files, generatedAt);
}

/** Minimal ZIP writer (deflate), enough for a handful of text files. */
function zip(files: { name: string; data: Buffer }[], date: Date): Buffer {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const compressed = deflateRawSync(f.data);
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
