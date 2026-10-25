/**
 * Create or reset an application user (stored in <META_SCHEMA>.QF_USERS, bcrypt hash).
 *   npm run user:create -- --username jdoe --name "Jane Doe" [--admin] [--groups finance,ops]
 * --groups replaces the user's LOCAL group memberships (lower case: a-z 0-9 . _ -).
 * The password is read from QF_NEW_PASSWORD or prompted on stdin (not echoed).
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config/config.js';
import { MapepireMetadataDb } from '../src/db/mapepire.js';
import { UserRepository } from '../src/auth/users.js';
import { GROUP_NAME_RE, GroupRepository } from '../src/sharing/groups.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  if (process.env.QF_NEW_PASSWORD) return process.env.QF_NEW_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => {
    if (s.includes('Password')) out.output.write(s);
  };
  const pw = await new Promise<string>((r) => rl.question('Password: ', r));
  rl.close();
  process.stdout.write('\n');
  return pw;
}

async function main() {
  const username = arg('username');
  if (!username) throw new Error('--username is required');
  const groupsArg = arg('groups');
  const groups =
    groupsArg === undefined
      ? undefined
      : groupsArg
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
  const bad = (groups ?? []).filter((g) => !GROUP_NAME_RE.test(g));
  if (bad.length)
    throw new Error(`Invalid group name(s): ${bad.join(', ')} (use lower case a-z 0-9 . _ -)`);
  const cfg = loadConfig();
  const db = new MapepireMetadataDb(cfg);
  try {
    const users = new UserRepository(db, cfg.metadata.schema);
    const password = await readPassword();
    const u = await users.upsert({
      username,
      displayName: arg('name') ?? username,
      password,
      role: process.argv.includes('--admin') ? 'ADMIN' : 'USER',
    });
    if (groups) await new GroupRepository(db, cfg.metadata.schema).sync(u.id, 'LOCAL', groups);
    console.log(
      `User ${u.username} (${u.id}) saved.${groups ? ` Groups: ${groups.join(', ') || '(none)'}` : ''}`,
    );
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
