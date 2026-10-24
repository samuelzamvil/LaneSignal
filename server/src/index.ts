import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccounts } from './accounts.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { startNotifier } from './notify.ts';
import { Store } from './store.ts';
import { TrmnlPusher } from './trmnl.ts';
import { ticketResolver } from './tickets.ts';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store({
  path: path.join(config.dataDir, 'lanesignal.db'),
  resolveTicketUrl: ticketResolver(config.ticketTemplates, config.defaultTicketSystem),
  eventRetention: config.eventRetention,
  broadTags: config.broadTags ?? undefined,
  attachmentsPerItem: config.attachmentsPerItem,
});
const accounts = await createAccounts(config, path.join(config.dataDir, 'lanesignal.db'));
// Everyone who could see the data before projects arrived keeps seeing it (once, on upgrade).
store.seedDefaultMembers(accounts.listUsers());
/** A person's phones get a project's push when they're active, can see it, and haven't turned it off. */
const wantsPush = (userId: string, project: string) => {
  if (!accounts.userActive(userId)) return false;
  const membership = store.membershipsOf(userId).get(project);
  return membership ? membership.notify : accounts.isAdmin(userId) && store.notifyChoice(project, userId) !== false;
};
const push = startNotifier(config, store, wantsPush);
accounts.people.on('gone', (userId, name, removed) => {
  store.removePushTokensOf(userId, name);
  if (removed) store.removeUserEverywhere(userId);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(process.env.LANESIGNAL_WEB_DIR ?? path.resolve(here, '../../web/dist'));
const skillFile = path.resolve(process.env.LANESIGNAL_SKILL_FILE ?? path.resolve(here, '../../skills/lanesignal/SKILL.md'));
const trmnlDir = path.resolve(process.env.LANESIGNAL_TRMNL_DIR ?? path.resolve(here, '../../integrations/trmnl'));
const trmnl = new TrmnlPusher(store).start();
const app = createApp({ config, store, accounts, push, webDir, skillFile, trmnl, trmnlDir });

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
  trmnl.stop();
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
