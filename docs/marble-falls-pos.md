# Marble Falls POS donations

The existing POST `/api/update-donation` accepts `{ "orderId": "{{order.id}}" }`.
POS orders with event product `gid://shopify/Product/10240532447526`
(Swag Locker Event (Marble Falls)) credit 25% of the current merchandise line
amounts after discounts. These amounts already include quantities and exclude
taxes and shipping. Removed items, gift cards and the event marker are excluded.
The customer's payment is never changed.

The handler identifies the school using the event product ID, not the generic
`Swag Locker` order tag. No tag needs to be added to the generic inventory products.
The marker qualifies the merchandise in that POS cart for Marble Falls. Use
separate transactions for other schools; do not mix unrelated merchandise into
a school event transaction. An order containing another named school event is
rejected for manual review.

## Shopify Flow

1. Keep the current Order created trigger.
2. For a POS order containing the Marble Falls event product, call
   `/api/update-donation` with the order ID. Do not call `/api/replace-dummy` on
   this branch. If payment has not completed, the handler returns HTTP 409;
   retain HTTP retry behavior or trigger the POS donation after payment.
3. Keep the online dummy-product replacement and donation branch as configured.

The current collection condition can include the POS event because the event
product belongs to the Marble Falls school collection. Verify the Flow run for
the POS test order. Even if the old parallel replacement action runs for POS,
the replacement endpoint now skips all POS orders without opening an order edit.

## Receipts, retries and cancellations

The page `custom.total_donations` money metafield and order
`custom.marble_falls_pos_donation` JSON receipt are written together using
Shopify's atomic `metafieldsSet` mutation and `compareDigest`. A repeated request
for an already recorded POS order does not add again. Concurrent POS requests
retry against the latest page total. The app needs access to read/write orders
and pages, including their metafields.

POST `/api/cancelled-donation` reverses only a recorded POS contribution, once,
after Shopify confirms that the order is cancelled. It does not guess a refund
for historical POS orders without a receipt. Partial-refund automation is outside
this change; after a POS donation has been credited, a retry does not recalculate
its amount.

The pre-existing online eligibility, rounding, and incremental update path remain
in place. Its duplicate protection, replacement timing and collection search
escaping are separate existing limitations. Online page writes also compare the
page digest and return retryable HTTP 409 on a conflict so they cannot overwrite
a newer POS credit using a stale total. The new POS receipt protects POS retries;
it does not add per-order receipts to the existing online flow.

## Validation and release

Run `node --test tests/pos-donation.test.cjs` and
`node node_modules/typescript/bin/tsc --noEmit --incremental false`.

For #ps3636, $44 merchandise gives $11 donation. A read-only preview must not
actually send the prepared mutation. After deployment, verify a new controlled
POS sale in Flow and its saved order receipt. Deployment does not automatically
reconcile or replay historical POS orders. Replaying an old order without a
receipt requires checking whether its donation was already included in the
legacy page total.
