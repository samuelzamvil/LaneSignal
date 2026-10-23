import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccounts } from './accounts.ts';
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
const accounts = await createAccounts(config, path.join(config.dataDir, 'lanesignal.db'));
const push = startNotifier(config, store, accounts.userActive);
accounts.people.on('gone', (userId, name) => store.removePushTokensOf(userId, name));

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(process.env.LANESIGNAL_WEB_DIR ?? path.resolve(here, '../../web/dist'));
const app = createApp({ config, store, accounts, push, webDir });

const server = app.listen(config.port, config.host, (err?: Error) => {
  if (err) {
    log.error('cannot listen', { host: config.host, port: config.port, error: String(err) });
    process.exit(1);
  }
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
    accounts.close();
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
