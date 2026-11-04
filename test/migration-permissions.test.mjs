/* isolated migration structural/runtime tests (Phase 3) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const lines = [];
function t(name, ok, info = '') {
  if (ok) { pass++; lines.push('PASS  ' + name); }
  else { fail++; lines.push('FAIL  ' + name + (info ? '  -> ' + info : '')); }
}

const migrationPath = path.join(root, 'worker', 'migrations', '001_permission_tables.sql');
const schemaPath = path.join(root, 'worker', 'schema.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

t('migration file exists', fs.existsSync(migrationPath));
t('schema.sql contains user_permissions', /CREATE TABLE IF NOT EXISTS user_permissions/i.test(schemaSql));
t('schema.sql contains permission_audit', /CREATE TABLE IF NOT EXISTS permission_audit/i.test(schemaSql));
t('migration is idempotent (IF NOT EXISTS)', /CREATE TABLE IF NOT EXISTS user_permissions/i.test(migrationSql) && /CREATE TABLE IF NOT EXISTS permission_audit/i.test(migrationSql));
t('migration has no INSERT into user_permissions', !/INSERT INTO user_permissions/i.test(migrationSql));
t('migration has no INSERT into permission_audit', !/INSERT INTO permission_audit/i.test(migrationSql));
t('migration has no UPDATE/DELETE data changes', !/^\s*(UPDATE|DELETE)\s+/im.test(migrationSql));

function freshDb() { return new DatabaseSync(':memory:'); }
function exec(db, sql) { db.exec(sql); }
function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}
function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL ORDER BY name").all().map((r) => r.name);
}
function triggerNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
}
function cols(db, table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
}

const db = freshDb();
exec(db, schemaSql);
exec(db, migrationSql);
exec(db, migrationSql);

t('user_permissions exists', db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_permissions'").get() !== undefined);
t('permission_audit exists', db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permission_audit'").get() !== undefined);

const upCols = cols(db, 'user_permissions').map((c) => c.name);
t('user_permissions has user_id', upCols.includes('user_id'));
t('user_permissions has permission', upCols.includes('permission'));
t('user_permissions has value', upCols.includes('value'));
t('user_permissions has updated_by', upCols.includes('updated_by'));
t('user_permissions has updated_at', upCols.includes('updated_at'));

const auditCols = cols(db, 'permission_audit').map((c) => c.name);
for (const c of ['id','at','actor_user_id','actor_name','target_user_id','target_name','change_type','permission','old_value','new_value','reason']) {
  t('permission_audit has ' + c, auditCols.includes(c));
}

// uniqueness
let uniqueOk = true;
try {
  db.prepare("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('u1','u1','u1','h','staff',1,'2026-01-01')").run();
  db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_at) VALUES ('u1','p',1,'2026-01-01')").run();
  db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_at) VALUES ('u1','p',0,'2026-01-02')").run();
  uniqueOk = false;
} catch (e) {
  uniqueOk = true;
}
t('user_permissions uniqueness (user_id, permission)', uniqueOk);

// value check
let valueCheckOk = true;
try {
  db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_at) VALUES ('u1','p2',2,'2026-01-01')").run();
  valueCheckOk = false;
} catch (e) {
  valueCheckOk = true;
}
t('user_permissions value CHECK (0/1)', valueCheckOk);

// change_type check
let changeTypeOk = true;
try {
  db.prepare("INSERT INTO permission_audit (id, at, change_type) VALUES ('a1','2026-01-01','bad')").run();
  changeTypeOk = false;
} catch (e) {
  changeTypeOk = true;
}
t('permission_audit change_type CHECK', changeTypeOk);

// allow/deny accepted
let allowDenyOk = true;
try {
  db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_at) VALUES ('u1','p3',0,'2026-01-01')").run();
  db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_at) VALUES ('u1','p4',1,'2026-01-01')").run();
} catch (e) {
  allowDenyOk = false;
}
t('Allow and Deny accepted', allowDenyOk);

// no backfill with pre-existing users
const noBackfillDb = freshDb();
noBackfillDb.exec(schemaSql);
noBackfillDb.prepare("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('u-existing-1','u-existing-1','User 1','h','staff',1,'2026-01-01')").run();
noBackfillDb.prepare("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('u-existing-2','u-existing-2','User 2','h','staff',1,'2026-01-01')").run();
const existingUsersBefore = noBackfillDb.prepare('SELECT * FROM users ORDER BY id').all();
noBackfillDb.exec(migrationSql);
const existingUsersAfter = noBackfillDb.prepare('SELECT * FROM users ORDER BY id').all();
t('no backfill: pre-existing users unchanged', JSON.stringify(existingUsersBefore) === JSON.stringify(existingUsersAfter));
t('no backfill: user_permissions empty after Migration', noBackfillDb.prepare('SELECT COUNT(*) c FROM user_permissions').get().c === 0);

// data integrity (same DB, snapshot before/after)
const integrityDb = freshDb();
integrityDb.exec(schemaSql);
integrityDb.prepare("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('ui','ui','User','h','staff',1,'2026-01-01')").run();
integrityDb.prepare("INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES ('oi',1001,'new','Customer','ui','2026-01-01','{\"id\":\"oi\"}','2026-01-01')").run();
integrityDb.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('ti','ui','2026-01-01','2026-02-01')").run();
const usersBefore = integrityDb.prepare('SELECT * FROM users ORDER BY id').all();
const ordersBefore = integrityDb.prepare('SELECT * FROM orders ORDER BY id').all();
const sessionsBefore = integrityDb.prepare('SELECT * FROM sessions ORDER BY token').all();
integrityDb.exec(migrationSql);
const usersAfter = integrityDb.prepare('SELECT * FROM users ORDER BY id').all();
const ordersAfter = integrityDb.prepare('SELECT * FROM orders ORDER BY id').all();
const sessionsAfter = integrityDb.prepare('SELECT * FROM sessions ORDER BY token').all();
t('data integrity: users unchanged', JSON.stringify(usersBefore) === JSON.stringify(usersAfter));
t('data integrity: orders unchanged', JSON.stringify(ordersBefore) === JSON.stringify(ordersAfter));
t('data integrity: sessions unchanged', JSON.stringify(sessionsBefore) === JSON.stringify(sessionsAfter));

// order: schema.sql then migration
let schemaThenMigrationOk = true;
let schemaThenMigrationError = '';
try {
  const dbA = freshDb();
  dbA.exec(schemaSql);
  dbA.exec(migrationSql);
  const aTables = tableNames(dbA);
  const aIndexes = indexNames(dbA);
  const aTriggers = triggerNames(dbA);
  const aUpCols = cols(dbA, 'user_permissions');
  const aAuditCols = cols(dbA, 'permission_audit');
  // store for comparison
  globalThis.__A__ = { tables: aTables, indexes: aIndexes, triggers: aTriggers, upCols: aUpCols, auditCols: aAuditCols };
} catch (e) {
  schemaThenMigrationOk = false;
  schemaThenMigrationError = String(e && e.message ? e.message : e);
}
t('order: schema.sql then migration succeeds', schemaThenMigrationOk, schemaThenMigrationError);

// order: migration then schema.sql
let migrationThenSchemaOk = true;
let migrationThenSchemaError = '';
try {
  const dbB = freshDb();
  dbB.exec(migrationSql);
  dbB.exec(schemaSql);
  const bTables = tableNames(dbB);
  const bIndexes = indexNames(dbB);
  const bTriggers = triggerNames(dbB);
  const bUpCols = cols(dbB, 'user_permissions');
  const bAuditCols = cols(dbB, 'permission_audit');
  const a = globalThis.__A__;
  t('order: migration then schema.sql succeeds', true);
  t('order: tables match', JSON.stringify(a.tables) === JSON.stringify(bTables));
  t('order: indexes match', JSON.stringify(a.indexes) === JSON.stringify(bIndexes));
  t('order: triggers match', JSON.stringify(a.triggers) === JSON.stringify(bTriggers));
  t('order: user_permissions columns match', JSON.stringify(a.upCols) === JSON.stringify(bUpCols));
  t('order: permission_audit columns match', JSON.stringify(a.auditCols) === JSON.stringify(bAuditCols));
} catch (e) {
  migrationThenSchemaOk = false;
  migrationThenSchemaError = String(e && e.message ? e.message : e);
  t('order: migration then schema.sql succeeds', false, migrationThenSchemaError);
}

// append-only triggers
let updateBlocked = false;
try {
  db.prepare("INSERT INTO permission_audit (id, at, change_type) VALUES ('a2','2026-01-01','permission')").run();
  db.prepare("UPDATE permission_audit SET reason='x' WHERE id='a2'").run();
} catch (e) {
  updateBlocked = true;
}
t('permission_audit UPDATE blocked (append-only)', updateBlocked);

let deleteBlocked = false;
try {
  db.prepare("DELETE FROM permission_audit WHERE id='a2'").run();
} catch (e) {
  deleteBlocked = true;
}
t('permission_audit DELETE blocked (append-only)', deleteBlocked);

const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((x) => x.name);
t('append-only update trigger exists', triggers.includes('permission_audit_no_update'));
t('append-only delete trigger exists', triggers.includes('permission_audit_no_delete'));

console.log(lines.join('\n'));
console.log('\n=== migration: PASS=' + pass + '  FAIL=' + fail + ' ===');
process.exit(fail ? 1 : 0);