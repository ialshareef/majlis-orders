/* isolated order ownership tests (Phase D2) */
import { verifyOrderOwnership, hasPerm } from '../worker/worker.js';

let pass = 0, fail = 0;
const lines = [];
function t(name, ok, info = '') {
  if (ok) { pass++; lines.push('PASS  ' + name); }
  else { fail++; lines.push('FAIL  ' + name + (info ? '  -> ' + info : '')); }
}

function makeDb(map, fail = false) {
  return {
    prepare(sql) {
      if (fail) throw new Error('db down');
      return {
        _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (fail) throw new Error('db down');
          const id = this._args[0];
          if (!Object.prototype.hasOwnProperty.call(map, id)) return null;
          return { created_by: map[id] };
        },
      };
    },
  };
}

const user = { id: 'u1', role: 'staff', active: 1 };
const other = { id: 'u2', role: 'staff', active: 1 };
const admin = { id: 'admin', role: 'admin', active: 1 };

// 1. owned
{
  const env = { DB: makeDb({ o1: 'u1' }) };
  const r = await verifyOrderOwnership(env, user, 'o1');
  t('owned -> allowed', r.allowed === true && r.reason === 'owned' && r.ownerId === 'u1');
}

// 2. not owned
{
  const env = { DB: makeDb({ o2: 'u2' }) };
  const r = await verifyOrderOwnership(env, user, 'o2');
  t('not owned -> denied', r.allowed === false && r.reason === 'not_owned' && r.ownerId === 'u2');
}

// 3. not found
{
  const env = { DB: makeDb({}) };
  const r = await verifyOrderOwnership(env, user, 'missing');
  t('not found -> denied', r.allowed === false && r.reason === 'not_found');
}

// 4. invalid user
{
  const env = { DB: makeDb({ o1: 'u1' }) };
  const r = await verifyOrderOwnership(env, null, 'o1');
  t('invalid user -> denied', r.allowed === false && r.reason === 'invalid_user');
}

// 5. missing created_by
{
  const env = { DB: makeDb({ o3: null }) };
  const r = await verifyOrderOwnership(env, user, 'o3');
  t('missing created_by -> invalid_owner', r.allowed === false && r.reason === 'invalid_owner');
}

// 6. empty created_by
{
  const env = { DB: makeDb({ o4: '' }) };
  const r = await verifyOrderOwnership(env, user, 'o4');
  t('empty created_by -> invalid_owner', r.allowed === false && r.reason === 'invalid_owner');
}

// 7. missing user.id
{
  const env = { DB: makeDb({ o1: 'u1' }) };
  const r = await verifyOrderOwnership(env, { role: 'staff', active: 1 }, 'o1');
  t('missing user.id -> invalid_user', r.allowed === false && r.reason === 'invalid_user');
}

// 8. type mismatch does not coerce
{
  const env = { DB: makeDb({ o5: 2 }) };
  const r = await verifyOrderOwnership(env, { id: '2', role: 'staff', active: 1 }, 'o5');
  t('type mismatch (string vs number) -> invalid_owner', r.allowed === false && r.reason === 'invalid_owner');
}
{
  const env = { DB: makeDb({ o6: '2' }) };
  const r = await verifyOrderOwnership(env, { id: 2, role: 'staff', active: 1 }, 'o6');
  t('type mismatch (number user.id) -> invalid_user', r.allowed === false && r.reason === 'invalid_user');
}

// 9. db failure
{
  const env = { DB: makeDb({}, true) };
  const r = await verifyOrderOwnership(env, user, 'o1');
  t('db failure -> db_error', r.allowed === false && r.reason === 'db_error');
}

// 10. client tampering createdBy is ignored (function reads DB only)
{
  const env = { DB: makeDb({ o1: 'u1' }) };
  const r = await verifyOrderOwnership(env, user, 'o1');
  t('client createdBy tampering ignored', r.allowed === true && r.reason === 'owned');
}

// 11. knowing orderId does not bypass ownership
{
  const env = { DB: makeDb({ secret: 'u2' }) };
  const r = await verifyOrderOwnership(env, user, 'secret');
  t('known orderId does not bypass', r.allowed === false && r.reason === 'not_owned');
}

// 12. admin separate from ownership + permission
{
  const env = { DB: makeDb({ o2: 'u2' }) };
  const r = await verifyOrderOwnership(env, admin, 'o2');
  t('admin ownership check still false for others order', r.allowed === false && r.reason === 'not_owned');
  t('admin orders.view_all separate permission', hasPerm(admin, 'orders.view_all') === true);
}

// invalid orderId
{
  const env = { DB: makeDb({ o1: 'u1' }) };
  const r = await verifyOrderOwnership(env, user, '');
  t('empty orderId -> invalid_order_id', r.allowed === false && r.reason === 'invalid_order_id');
}

console.log(lines.join('\n'));
console.log('\n=== order-ownership: PASS=' + pass + '  FAIL=' + fail + ' ===');
process.exit(fail ? 1 : 0);