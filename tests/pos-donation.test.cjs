const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/lib/pos-donation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const orderId = 'gid://shopify/Order/11205036507430';
const pageId = 'gid://shopify/Page/154228228390';
const markerId = 'gid://shopify/Product/10240532447526';
const item = (amount, extra = {}) => ({
  title: 'Actual scanned hoodie', currentQuantity: 1, isGiftCard: false,
  priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount, currencyCode: 'USD' } },
  product: { id: 'gid://shopify/Product/10556685222182' }, ...extra,
});
function harness(options = {}) {
  const state = {
    ledger: null, total: '438.45', revision: 1, writes: 0, attempts: 0,
    items: [item('0.0', { title: 'Swag Locker Event (Marble Falls)', product: { id: markerId } }), item('44.0')],
    calls: [], cancelledAt: null, sourceName: 'pos', financialStatus: 'PAID', ...options,
  };
  const field = () => ({ value: JSON.stringify({ amount: state.total, currency_code: 'USD' }), compareDigest: String(state.revision) });
  const fetch = async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    state.calls.push(query);
    let data;
    if (query.includes('query posDonationOrder')) {
      data = { order: { id: orderId, name: '#ps3636', sourceName: state.sourceName,
        cancelledAt: state.cancelledAt, displayFinancialStatus: state.financialStatus,
        ledger: state.ledger && { value: JSON.stringify(state.ledger), compareDigest: 'receipt' } } };
    } else if (query.includes('query posDonationItems')) {
      data = { order: { lineItems: { nodes: state.paginate && !variables.after ? state.items.slice(1) : state.paginate ? state.items.slice(0, 1) : state.items,
        pageInfo: { hasNextPage: !!state.paginate && !variables.after, endCursor: 'next' } } } };
    } else if (query.includes('query posDonationPage')) {
      data = { pages: { nodes: [{ id: pageId, handle: 'marble-falls' }], pageInfo: { hasNextPage: false } } };
    } else if (query.includes('query posDonationTotal')) {
      data = { page: { total: state.badCurrency ? { value: '{"amount":"438.45","currency_code":"CAD"}', compareDigest: '1' } : field() } };
    } else if (query.includes('mutation posDonationSet')) {
      state.attempts++;
      const [total, receipt] = variables.metafields;
      assert.equal(total.ownerId, pageId);
      assert.equal(receipt.ownerId, orderId);
      if (state.concurrentDuplicate && state.attempts === 1) {
        state.ledger = JSON.parse(receipt.value); state.total = '449.45'; state.revision++;
      } else if (state.conflict && state.attempts === 1) {
        state.total = '440.45'; state.revision++;
      }
      if (state.failWrite) {
        data = { metafieldsSet: { userErrors: [{ code: 'INVALID_VALUE', message: 'Write denied' }] } };
      } else if (state.alwaysConflict || total.compareDigest !== String(state.revision) ||
          receipt.compareDigest !== (state.ledger ? 'receipt' : null)) {
        data = { metafieldsSet: { userErrors: [{ code: 'INVALID_COMPARE_DIGEST', message: 'Stale' }] } };
      } else {
        state.total = JSON.parse(total.value).amount;
        state.ledger = JSON.parse(receipt.value); state.revision++; state.writes++;
        data = { metafieldsSet: { userErrors: [] } };
      }
    } else throw new Error('Unexpected Shopify operation');
    return { ok: true, status: 200, json: async () => structuredClone({ data }) };
  };
  const exports = {};
  vm.runInNewContext(source, { exports, require, fetch,
    process: { env: { SHOPIFY_STORE_DOMAIN: 'test.invalid', SHOPIFY_ADMIN_API_TOKEN: 'fake' } } });
  return { state, run: (action = 'credit') => exports.handlePosDonation(orderId, action) };
}

test('$44 POS merchandise adds $11 to page, and saves an order receipt atomically', async () => {
  const { state, run } = harness();
  const body = await (await run()).json();
  assert.equal(body.donationAmount, '11.00'); assert.equal(body.eligibleSubtotal, '44.00');
  assert.equal(state.total, '449.45'); assert.equal(state.writes, 1);
  assert.equal(state.ledger.amountCents, 1100);
});
test('sequential Flow retry does not add the same donation again', async () => {
  const { state, run } = harness(); await run();
  assert.equal((await (await run()).json()).skipped, true);
  assert.equal(state.total, '449.45'); assert.equal(state.writes, 1);
});
test('competing duplicate receipt prevents a second credit', async () => {
  const { state, run } = harness({ concurrentDuplicate: true });
  assert.equal((await (await run()).json()).skipped, true);
  assert.equal(state.total, '449.45'); assert.equal(state.writes, 0);
});
test('page digest conflict rereads the latest total before adding', async () => {
  const { state, run } = harness({ conflict: true }); await run();
  assert.equal(state.total, '451.45'); assert.equal(state.attempts, 2);
});
test('unresolved conflicts return retryable 409 without writing', async () => {
  const { state, run } = harness({ alwaysConflict: true });
  assert.equal((await run()).status, 409); assert.equal(state.writes, 0);
});
test('online orders continue through the existing handler', async () => {
  const { state, run } = harness({ sourceName: 'web' });
  assert.equal(await run(), null); assert.equal(state.calls.length, 1); assert.equal(state.writes, 0);
});
test('a generic Swag Locker tag cannot qualify a POS order without the exact event product', async () => {
  const { state, run } = harness({ items: [item('44.0')] });
  assert.equal((await (await run()).json()).skipped, true); assert.equal(state.writes, 0);
});
test('an event with the same title but another product ID does not qualify', async () => {
  const { state, run } = harness({ items: [item('0.0', { title: 'Swag Locker Event (Marble Falls)' }), item('44.0')] });
  assert.equal((await (await run()).json()).skipped, true); assert.equal(state.writes, 0);
});
test('removed event marker cannot qualify an order', async () => {
  const h = harness(); h.state.items[0].currentQuantity = 0;
  assert.equal((await (await h.run()).json()).skipped, true); assert.equal(h.state.writes, 0);
});
test('net line amounts include quantities and discounts; gift cards and removed lines are excluded', async () => {
  const h = harness(); h.state.items.push(item('88.0'), item('100.0', { isGiftCard: true }), item('99.0', { currentQuantity: 0 }));
  const body = await (await h.run()).json();
  assert.equal(body.eligibleSubtotal, '132.00'); assert.equal(body.donationAmount, '33.00');
});
test('fractional-cent donations round once per order', async () => {
  const h = harness(); h.state.items[1] = item('172.5');
  assert.equal((await (await h.run()).json()).donationAmount, '43.13');
});
test('line items are paginated so a later event marker is found', async () => {
  const h = harness({ paginate: true });
  assert.equal((await (await h.run()).json()).donationAmount, '11.00');
});
test('unpaid orders are retryable and cancelled orders cannot be credited', async () => {
  const unpaid = harness({ financialStatus: 'PENDING' });
  assert.equal((await unpaid.run()).status, 409); assert.equal(unpaid.state.writes, 0);
  const cancelled = harness({ cancelledAt: '2026-10-28T10:00:00Z' });
  assert.equal((await (await cancelled.run()).json()).skipped, true); assert.equal(cancelled.state.writes, 0);
});
test('cancel reverses the saved amount exactly once, even after products change', async () => {
  const h = harness(); await h.run(); h.state.cancelledAt = '2026-10-28T10:00:00Z'; h.state.items = [];
  assert.equal((await (await h.run('cancel')).json()).removed, '11.00');
  assert.equal(h.state.total, '438.45'); assert.equal(h.state.ledger.status, 'cancelled');
  assert.equal((await (await h.run('cancel')).json()).skipped, true); assert.equal(h.state.writes, 2);
});
test('uncancelled orders cannot be reversed; uncredited cancellations do not subtract', async () => {
  const h = harness(); assert.equal((await h.run('cancel')).status, 400);
  h.state.cancelledAt = '2026-10-28T10:00:00Z';
  assert.equal((await (await h.run('cancel')).json()).skipped, true); assert.equal(h.state.writes, 0);
});
test('failed atomic write leaves both total and receipt unchanged', async () => {
  const h = harness({ failWrite: true }); await assert.rejects(h.run, /Write denied/);
  assert.equal(h.state.total, '438.45'); assert.equal(h.state.ledger, null);
});
test('currency mismatch and ambiguous school events do not write', async () => {
  const h = harness({ badCurrency: true }); await assert.rejects(h.run, /currency/);
  const mixed = harness(); mixed.state.items.push(item('0.0', { title: 'Swag Locker Event (Another School)' }));
  assert.equal((await mixed.run()).status, 422); assert.equal(mixed.state.writes, 0);
});

function route(path, posHandler, fetch) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { exports,
    require: (name) => name === '@/lib/pos-donation' ? { handlePosDonation: posHandler } : require(name),
    fetch, process: { env: { SHOPIFY_STORE_DOMAIN: 'test.invalid', SHOPIFY_ADMIN_API_TOKEN: 'fake' } },
    console: { log() {}, error() {} },
  });
  return exports.POST;
}
test('update and cancellation endpoints dispatch POS orders before the old collection calculation', async () => {
  for (const [path, action] of [
    ['src/app/api/update-donation/route.ts', 'credit'],
    ['src/app/api/cancelled-donation/route.ts', 'cancel'],
  ]) {
    const handler = route(path, async (id, mode) => {
      assert.equal(id, orderId); assert.equal(mode, action);
      return Response.json({ success: true, source: 'pos' });
    }, () => { throw new Error('Old path must not run for POS'); });
    const result = await handler({ json: async () => ({ orderId }) });
    assert.equal((await result.json()).source, 'pos');
  }
});
test('POS replacement is skipped even when the actual product has a SIZE tag', async () => {
  let calls = 0;
  const handler = route('src/app/api/replace-dummy/route.ts', null, async (_url, options) => {
    calls++;
    assert.match(JSON.parse(options.body).query, /query replacementOrderSource/);
    return { json: async () => ({ data: { order: { sourceName: 'pos' } } }) };
  });
  const result = await handler({ json: async () => ({ orderId, lineItems: [{ sku: 'PS300HW-2607C-SIZE', size: 'M' }] }) });
  assert.equal((await result.json()).skipped, true); assert.equal(calls, 1);
});
test('existing online credit and cancellation use the page digest and return 409 on stale writes', async () => {
  for (const path of ['src/app/api/update-donation/route.ts', 'src/app/api/cancelled-donation/route.ts']) {
    let wrote = false;
    const handler = route(path, async () => null, async (_url, options) => {
      const { query, variables } = JSON.parse(options.body);
      let data;
      if (/query getDonationOrder|query getCancelledDonationOrder/.test(query)) {
        data = { order: { id: orderId, name: '#online', lineItems: { nodes: [{ id: 'line', title: 'Mustang', sku: null,
          priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: '44.0', currencyCode: 'USD' } },
          originalTotalSet: { shopMoney: { amount: '44.0', currencyCode: 'USD' } },
          product: { collections: { nodes: [{ title: 'Marble Falls Mustangs Athletics Apparel & Fan Gear' }] } },
        }] } } };
      } else if (query.includes('query getMarbleFallsPage')) {
        data = { pages: { nodes: [{ id: pageId, title: 'Marble Falls' }] } };
      } else if (query.includes('query getPageMetafields')) {
        assert.match(query, /compareDigest/);
        data = { page: { metafields: { nodes: [{ key: 'total_donations', value: '{"amount":"438.45","currency_code":"USD"}', compareDigest: 'observed' }] } } };
      } else {
        assert.match(query, /mutation setDonationMetafield/);
        assert.equal(variables.metafields[0].compareDigest, 'observed'); wrote = true;
        data = { metafieldsSet: { userErrors: [{ field: ['metafields'], code: 'INVALID_COMPARE_DIGEST', message: 'Stale' }] } };
      }
      return { ok: true, json: async () => ({ data }) };
    });
    assert.equal((await handler({ json: async () => ({ orderId }) })).status, 409);
    assert.equal(wrote, true);
  }
});
