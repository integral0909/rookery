import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { destroyUserSessions, hashPassword } from './server/auth.js';
import { openDatabase, transaction } from './server/db.js';
import { addMember, createChannel, openDm } from './server/model/channels.js';
import { postMessage } from './server/model/messages.js';
import { USERNAME } from './server/validate.js';

const HELP = `Usage: npm run cli -- <command> [options]

Commands
  backup <file>                 Write a consistent copy of the database to <file>
  stats                         Show counts of users, channels and messages
  user create <name> [--admin]  Create an account (password printed, or ROOKERY_PASSWORD)
  user reset-password <name>    Set a new random password and sign the user out
  user promote <name>           Make an account an admin
  user deactivate <name>        Block an account and end its sessions
  demo                          Fill an empty database with a sample team

The database is ROOKERY_DB (default data/rookery.db).`;

export class CliError extends Error {}

const randomPassword = () => randomBytes(12).toString('base64url');

function findUser(db, name) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!user) throw new CliError(`no user called ${name}`);
  return user;
}

async function createUser(db, username, { admin = false, password, displayName } = {}) {
  if (!USERNAME.test(username) || username.length < 2 || username.length > 32) throw new CliError(`invalid username: ${username}`);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new CliError(`${username} already exists`);
  const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const { lastInsertRowid: id } = db
    .prepare('INSERT INTO users (username, display_name, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName || username, await hashPassword(password), Date.now(), admin || first ? 1 : 0);
  // Same as signing up in the browser: everyone is in #general.
  let general = db.prepare("SELECT * FROM channels WHERE name = 'general'").get();
  if (!general) general = createChannel(db, { kind: 'public', name: 'general', topic: 'Company-wide announcements and chatter', createdBy: Number(id) });
  else addMember(db, general.id, Number(id));
  return Number(id);
}

export async function run(argv, { db, print = console.log, env = process.env } = {}) {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case 'backup': {
      if (!sub) throw new CliError('backup needs a file name');
      const target = resolve(sub);
      if (existsSync(target)) throw new CliError(`${target} already exists`);
      mkdirSync(dirname(target), { recursive: true });
      db.prepare('VACUUM INTO ?').run(target);
      print(`backed up to ${target}`);
      return;
    }
    case 'stats': {
      const one = (sql) => db.prepare(sql).get().n;
      print(`users      ${one('SELECT COUNT(*) AS n FROM users WHERE deactivated_at IS NULL')} active, ${one('SELECT COUNT(*) AS n FROM users WHERE deactivated_at IS NOT NULL')} deactivated`);
      print(`channels   ${one("SELECT COUNT(*) AS n FROM channels WHERE kind = 'public'")} public, ${one("SELECT COUNT(*) AS n FROM channels WHERE kind = 'private'")} private, ${one("SELECT COUNT(*) AS n FROM channels WHERE kind = 'dm'")} direct`);
      print(`messages   ${one('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL')}`);
      print(`sessions   ${one('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > CAST(unixepoch(\'subsec\') * 1000 AS INTEGER)')} active`);
      return;
    }
    case 'user': {
      const name = rest[0];
      if (!name) throw new CliError(`user ${sub ?? ''} needs a username`);
      if (sub === 'create') {
        const password = env.ROOKERY_PASSWORD || randomPassword();
        await createUser(db, name, { admin: rest.includes('--admin'), password });
        print(env.ROOKERY_PASSWORD ? `created ${name}` : `created ${name} with password ${password}`);
      } else if (sub === 'reset-password') {
        const user = findUser(db, name);
        const password = env.ROOKERY_PASSWORD || randomPassword();
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
        destroyUserSessions(db, user.id);
        print(env.ROOKERY_PASSWORD ? `password for ${name} changed` : `new password for ${name}: ${password}`);
      } else if (sub === 'promote') {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(findUser(db, name).id);
        print(`${name} is now an admin`);
      } else if (sub === 'deactivate') {
        const user = findUser(db, name);
        db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(Date.now(), user.id);
        destroyUserSessions(db, user.id);
        print(`${name} is deactivated`);
      } else throw new CliError(`unknown user command: ${sub ?? ''}`);
      return;
    }
    case 'demo':
      await demo(db, print, env);
      return;
    case undefined:
    case 'help':
    case '--help':
      print(HELP);
      return;
    default:
      throw new CliError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

// A small team with a few days of history, for trying the app out.
async function demo(db, print, env) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new CliError('demo data only goes into an empty database');
  const password = env.ROOKERY_PASSWORD || 'rookery-demo';
  const people = [
    ['maya', 'Maya Okafor'],
    ['tomas', 'Tomás Lindqvist'],
    ['priya', 'Priya Raman'],
    ['jun', 'Jun Takeda'],
    ['elena', 'Elena Petrova'],
  ];
  const ids = {};
  for (const [username, displayName] of people) ids[username] = await createUser(db, username, { password, displayName });
  const start = Date.now() - 3 * 86400_000;
  let clock = start;
  const at = (minutes) => (clock += minutes * 60_000);

  transaction(db, () => {
    const general = db.prepare("SELECT * FROM channels WHERE name = 'general'").get();
    const eng = createChannel(db, { kind: 'public', name: 'engineering', topic: 'Builds, reviews and on-call', createdBy: ids.tomas, members: [ids.priya, ids.jun, ids.maya] });
    const design = createChannel(db, { kind: 'public', name: 'design', topic: 'Mockups and feedback', createdBy: ids.elena, members: [ids.maya] });
    const leads = createChannel(db, { kind: 'private', name: 'leads', topic: 'Planning', createdBy: ids.maya, members: [ids.tomas, ids.elena] });
    const say = (channel, who, body, minutes = 3, parentId = null) =>
      postMessage(db, { channelId: channel.id, userId: ids[who], body, parentId, now: at(minutes) });

    say(general, 'maya', 'Morning everyone! Reminder: all-hands is Thursday at 15:00 :coffee:', 0);
    say(general, 'jun', 'Thanks Maya. Will there be a recording?', 4);
    say(general, 'maya', 'Yes, it will be posted in #general afterwards.', 2);
    const release = say(eng, 'tomas', 'Release 2.4 is cut. Please run the smoke tests on staging before 14:00.', 30);
    say(eng, 'priya', 'Running them now', 3, release.id);
    say(eng, 'priya', 'All green except the export job, which times out on the big fixture. Looking into it.', 25, release.id);
    say(eng, 'jun', 'That fixture grew to 40k rows last week, might just need a bigger timeout', 4, release.id);
    say(eng, 'priya', '@tomas found it: the export query lost its index in the last migration. Fix:\n```\nCREATE INDEX exports_owner ON exports(owner_id, created_at);\n```', 40);
    say(eng, 'tomas', 'Nice catch :tada: Ship it.', 5);
    say(design, 'elena', 'New onboarding mockups are up for review. Feedback welcome, especially on step 3.', 120);
    say(design, 'maya', 'Love the progress bar. Step 3 has a lot of text, could we split it?', 20);
    say(leads, 'maya', 'Hiring update: two offers out for the backend role.', 200);
    say(leads, 'tomas', 'Great. I can do the technical onboarding for whoever joins.', 10);
    const { row: dm } = openDm(db, [ids.maya, ids.priya]);
    say(dm, 'maya', 'Thanks for jumping on the export bug so quickly today!', 300);
    say(dm, 'priya', 'Happy to, it was a fun one to track down', 5);
    say(general, 'elena', 'Cake in the kitchen for Jun’s birthday :party:', 900);
    say(general, 'jun', 'Thank you all! 🎂', 6);
    db.prepare("UPDATE memberships SET last_read_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = memberships.channel_id)").run();
  });
  print(`demo team created: ${people.map(([u]) => u).join(', ')} (password: ${password})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dbPath = process.env.ROOKERY_DB || 'data/rookery.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    await run(process.argv.slice(2), { db });
  } catch (err) {
    console.error(err instanceof CliError ? err.message : err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
