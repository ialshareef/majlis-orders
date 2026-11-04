/* isolated permission tests (Phase 2) */
import { PERMISSIONS, ROLE_PERMISSIONS, hasPerm, effectivePermissions, PROTECTED_ADMIN_PERMISSIONS } from '../worker/worker.js';

let pass = 0, fail = 0;
const lines = [];
function t(name, ok, info = '') {
  if (ok) { pass++; lines.push('PASS  ' + name); }
  else { fail++; lines.push('FAIL  ' + name + (info ? '  -> ' + info : '')); }
}

const admin = { role: 'admin', active: 1 };
const staff = { role: 'staff', active: 1 };
const mandoub = { role: 'mandoub', active: 1 };
const inactive = { role: 'admin', active: 0 };

// basic invalid
t('invalid user -> false', hasPerm(null, 'orders.view_own') === false);
t('invalid permission -> false', hasPerm(admin, 'nope') === false);
t('unknown role -> false', hasPerm({ role: 'ghost', active: 1 }, 'orders.view_own') === false);
t('inactive user -> false', hasPerm(inactive, 'orders.view_own') === false);

// allowed sets
for (const p of ROLE_PERMISSIONS.staff) t('staff allows ' + p, hasPerm(staff, p) === true);
for (const p of ROLE_PERMISSIONS.mandoub) t('mandoub allows ' + p, hasPerm(mandoub, p) === true);
t('admin allows all', Object.keys(PERMISSIONS).every((p) => hasPerm(admin, p)));

// denied examples
t('staff denies orders.view_all', hasPerm(staff, 'orders.view_all') === false);
t('staff denies costs.delete_own', hasPerm(staff, 'costs.delete_own') === false);
t('mandoub denies designs.manage', hasPerm(mandoub, 'designs.manage') === false);
t('mandoub denies reports.view_all', hasPerm(mandoub, 'reports.view_all') === false);

// delete perms (admin only)
t('orders.delete_own admin only', hasPerm(admin, 'orders.delete_own') && !hasPerm(staff, 'orders.delete_own') && !hasPerm(mandoub, 'orders.delete_own'));
t('costs.delete_own admin only', hasPerm(admin, 'costs.delete_own') && !hasPerm(staff, 'costs.delete_own') && !hasPerm(mandoub, 'costs.delete_own'));

// designs.manage admin only
t('designs.manage admin only', hasPerm(admin, 'designs.manage') && !hasPerm(staff, 'designs.manage') && !hasPerm(mandoub, 'designs.manage'));

// permissions.manage admin only
t('permissions.manage admin only', hasPerm(admin, 'permissions.manage') && !hasPerm(staff, 'permissions.manage') && !hasPerm(mandoub, 'permissions.manage'));

// admin.core protected
t('admin.core admin only', hasPerm(admin, 'admin.core') && !hasPerm(staff, 'admin.core') && !hasPerm(mandoub, 'admin.core'));
t('PROTECTED_ADMIN_PERMISSIONS contains admin.core', PROTECTED_ADMIN_PERMISSIONS.includes('admin.core'));

// unknown perm default deny
t('unknown perm deny (admin)', hasPerm(admin, 'future.perm') === false);
t('unknown perm deny (staff)', hasPerm(staff, 'future.perm') === false);


// override: deny beats role allow
t('override deny orders.view_own (admin)', hasPerm({ role: 'admin', active: 1, permissions: { 'orders.view_own': false } }, 'orders.view_own') === false);
t('override deny via 3rd arg', hasPerm({ role: 'admin', active: 1 }, 'orders.view_own', { 'orders.view_own': 0 }) === false);

// override: allow grants default-denied perm
t('override allow orders.view_all (staff)', hasPerm({ role: 'staff', active: 1, permissions: { 'orders.view_all': true } }, 'orders.view_all') === true);
t('override allow via 3rd arg', hasPerm({ role: 'staff', active: 1 }, 'orders.view_all', { 'orders.view_all': 1 }) === true);

// admin.core cannot be granted to non-admin by override
t('admin.core override denied for staff', hasPerm({ role: 'staff', active: 1, permissions: { 'admin.core': true } }, 'admin.core') === false);
t('admin.core override denied for mandoub', hasPerm({ role: 'mandoub', active: 1 }, 'admin.core', { 'admin.core': true }) === false);

// unknown override ignored
t('unknown override ignored', hasPerm({ role: 'staff', active: 1, permissions: { 'future.perm': true } }, 'future.perm') === false);

// effectivePermissions
const ep = effectivePermissions({ role: 'staff', active: 1, permissions: { 'orders.view_all': true, 'orders.view_own': false } });
t('effective includes override allow', ep.has('orders.view_all'));
t('effective excludes override deny', !ep.has('orders.view_own'));
t('effective excludes unknown', !ep.has('future.perm'));


// structured load result: empty success -> role defaults
t('load result empty success allows role default', hasPerm({ role: 'staff', active: 1 }, 'orders.view_own', { ok: true, overrides: {} }) === true);

// structured load result: failure -> fail-closed
t('load result failure denies role default', hasPerm({ role: 'admin', active: 1 }, 'orders.view_own', { ok: false, overrides: {} }) === false);
t('load result failure denies all perms', hasPerm({ role: 'admin', active: 1 }, 'orders.view_all', { ok: false, overrides: {} }) === false);

// admin.core protected even with structured deny/allow
t('admin.core protected (structured deny)', hasPerm({ role: 'admin', active: 1 }, 'admin.core', { ok: true, overrides: { 'admin.core': false } }) === true);
t('admin.core protected (structured allow non-admin)', hasPerm({ role: 'staff', active: 1 }, 'admin.core', { ok: true, overrides: { 'admin.core': true } }) === false);

// unknown override ignored
t('unknown override ignored (structured)', hasPerm({ role: 'staff', active: 1, permissions: { 'future.perm': true } }, 'future.perm') === false);

// effectivePermissions fail-closed on load failure
const epFail = effectivePermissions({ role: 'admin', active: 1 }, { ok: false, overrides: {} });
t('effective fail-closed empty', epFail.size === 0);

console.log(lines.join('\n'));
console.log('\n=== permissions: PASS=' + pass + '  FAIL=' + fail + ' ===');
process.exit(fail ? 1 : 0);