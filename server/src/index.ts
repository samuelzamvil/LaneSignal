import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { startNotifier } from './notify.ts';
import { Store } from './store.ts';
import { ticketResolver } from './tickets.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store({
  path: path.join(config.dataDir, 'lanesignal.db'),
  resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem),
  eventRetention: config.eventRetention,
});
const push = startNotifier(config, store);

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = process.env.LANESIGNAL_WEB_DIR ?? path.resolve(here, '../../web/dist');
const app = createApp({ config, store, push, webDir });

const server = app.listen(config.port, config.host, () => {
  log.info('lanesignal listening', {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    tokens: config.tokens.map((t) => `${t.name}:${t.role}`),
    push,
  });
});

function shutdown(signal: string) {
  log.info('shutting down', { signal });
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
