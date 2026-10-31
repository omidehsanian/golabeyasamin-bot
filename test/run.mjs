import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { addProduct, deleteProduct, findProductIdByButton, listProducts, moveProduct } from '../products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { prepare, batch, raw } = makeD1();
const env = { DB: { prepare, batch } };

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
raw.exec(schema);

async function main() {
  // --- users / wallet ---
  await db.ensureUser(env, '111');
  await db.ensureUser(env, '222');
  assert.ok((await db.getUser(env, '111')) !== null, 'user 111 should exist');
  assert.equal(await db.getWallet(env, '111'), 0, 'initial wallet should be 0');

  await db.adminAdjustWallet(env, '111', 50000, 'test:seed:111');
  assert.equal(await db.getWallet(env, '111'), 50000, 'wallet should be 50000 after add');
  await assert.rejects(() => db.ensureUser(env, undefined), /invalid chat_id/, 'chat_id "undefined" must be rejected');
  console.log('✅ users/wallet basic ops OK');

  // --- registration ---
  assert.equal(await db.isRegistered(env, '111'), false, 'should not be registered yet');
  await db.saveRegistration(env, '111', { phone_number: '0912xxxxxxx', first_name: 'Ali', last_name: 'Rezaei' });
  assert.equal(await db.isRegistered(env, '111'), true, 'should be registered now');
  assert.equal(await db.getFullName(env, '111'), 'Ali Rezaei', 'full name should match');
  console.log('✅ registration OK');

  // --- channel confirmed ---
  assert.equal(await db.isChannelConfirmed(env, '111'), false, 'should not be confirmed yet');
  await db.setChannelConfirmed(env, '111');
  assert.equal(await db.isChannelConfirmed(env, '111'), true, 'should be confirmed now');
  console.log('✅ channel_confirmed flag OK');

  // --- referral: only the relation is recorded, no money moves ---
  assert.equal(await db.registerReferral(env, '111', '222'), true, 'first referral should be recorded');
  assert.equal(await db.registerReferral(env, '111', '222'), false, 'duplicate referral should be rejected');
  assert.equal(await db.registerReferral(env, '222', '222'), false, 'self referral should be rejected');
  assert.equal(await db.getWallet(env, '111'), 50000, 'registering a referral must not pay anything');
  assert.equal(await db.getReferralStats(env, '111'), 1, 'referral stats should be 1');
  console.log('✅ referral dedup (no reward at registration) OK');

  // --- products: جایگاه دکمه‌ها همیشه ۱..n پشت‌سرهم ---
  const titles = async () => (await listProducts(env)).map((p) => `${p.position}:${p.title}`).join(' ');
  const a = await addProduct(env, { title: 'A', description: 'a', photoFileId: 'f', price: 100, position: 1 });
  await addProduct(env, { title: 'B', description: 'b', photoFileId: 'f', price: 200, position: 2 });
  await addProduct(env, { title: 'C', description: 'c', photoFileId: 'f', price: 300, position: 1 });
  assert.equal(await titles(), '1:C 2:A 3:B', 'insert at position shifts the rest');
  await addProduct(env, { title: 'D', description: 'd', photoFileId: 'f', price: 400, position: 99 });
  assert.equal(await titles(), '1:C 2:A 3:B 4:D', 'out-of-range position goes last');
  await moveProduct(env, a.id, 4);
  assert.equal(await titles(), '1:C 2:B 3:D 4:A', 'move down');
  await moveProduct(env, a.id, 1);
  assert.equal(await titles(), '1:A 2:C 3:B 4:D', 'move up');
  await deleteProduct(env, a.id);
  assert.equal(await titles(), '1:C 2:B 3:D', 'delete closes the gap');
  assert.equal(await findProductIdByButton(env, 'B'), (await listProducts(env))[1].id);
  for (const p of await listProducts(env)) await deleteProduct(env, p.id);
  console.log('✅ product positions (insert / move / delete) OK');

  // --- orders + confirm (wallet deduction, no double-deduct) ---
  const orderId = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT Plus', {
    amount: 70000,
    walletUsed: 50000,
    status: 'awaiting_confirmation',
  });
  assert.ok(Number.isInteger(orderId) && orderId > 0, 'order id should be a positive integer');

  const confirmed = await db.confirmOrder(env, orderId);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.order.status, 'confirmed', 'order should be confirmed');
  assert.equal(await db.getWallet(env, '111'), 0, 'wallet should be reduced by exactly wallet_used');

  const again = await db.confirmOrder(env, orderId);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_confirmed');
  assert.equal(await db.getWallet(env, '111'), 0, 'confirming twice must NOT deduct again');
  console.log('✅ order confirm + double-confirm guard OK');

  // --- reject flow ---
  await db.adminAdjustWallet(env, '111', 10000, 'test:seed2:111');
  const orderId2 = await db.saveOrder(env, '111', 'canva', 'Canva Pro', { amount: 30000, walletUsed: 10000, status: 'receipt_sent' });
  const rejected = await db.rejectOrder(env, orderId2);
  assert.equal(rejected.order.status, 'rejected', 'order should be rejected');
  assert.equal(await db.getWallet(env, '111'), 10000, 'reject must not touch wallet');
  assert.equal((await db.confirmOrder(env, orderId2)).reason, 'invalid_status', 'a rejected order cannot be confirmed');
  assert.equal(await db.getWallet(env, '111'), 10000);
  console.log('✅ reject flow leaves wallet untouched OK');

  // --- sessions ---
  await db.setSession(env, '333', 'order_full_name', {});
  let s = await db.getSession(env, '333');
  assert.equal(s.state, 'order_full_name', 'session state should be set');
  await db.setSession(env, '333', 'order_phone', { fullName: 'Test User' });
  s = await db.getSession(env, '333');
  assert.ok(s.state === 'order_phone' && s.data.fullName === 'Test User', 'session data should update');
  await db.clearSession(env, '333');
  assert.equal((await db.getSession(env, '333')).state, null, 'session should be cleared');
  console.log('✅ session lifecycle OK');

  // --- getAllChatIds ---
  const all = await db.getAllChatIds(env);
  assert.ok(all.includes('111') && all.includes('222'), 'getAllChatIds should include both users');
  console.log('✅ getAllChatIds OK');

  console.log('\nALL DB SMOKE TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
