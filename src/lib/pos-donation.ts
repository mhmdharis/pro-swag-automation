import { NextResponse } from "next/server";

// Verified event product from POS order #ps3636. Match the product ID, not a
// generic order tag that could also belong to another school's sale.
export const MARBLE_FALLS_EVENT_PRODUCT_ID =
  "gid://shopify/Product/10240532447526";
const LEDGER_KEY = "marble_falls_pos_donation";

type Metafield = { value: string; compareDigest: string };
type Money = { amount: string; currencyCode: string };
type Ledger = {
  version: 1;
  pageId: string;
  amountCents: number;
  currencyCode: string;
  status: "credited" | "cancelled";
};
type PosOrder = {
  id: string;
  name: string;
  sourceName: string;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  ledger: Metafield | null;
};
type PosLineItem = {
  title: string;
  currentQuantity: number;
  isGiftCard: boolean;
  priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: Money };
  product: { id: string } | null;
};

async function shopify<T>(query: string, variables: Record<string, unknown>) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  if (!domain || !token) throw new Error("Shopify configuration is missing");
  const response = await fetch(
    `https://${domain}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    }
  );
  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (!response.ok || result.errors?.length || !result.data) {
    throw new Error(result.errors?.map((e) => e.message).join("; ") ||
      `Shopify request failed (${response.status})`);
  }
  return result.data;
}

function cents(amount: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error("Invalid donation money amount");
  }
  const [whole, fraction = ""] = amount.split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(value)) throw new Error("Donation amount is too large");
  return value;
}

function readLedger(field: Metafield | null): Ledger | null {
  if (!field) return null;
  const value = JSON.parse(field.value) as Ledger;
  if (value.version !== 1 || !Number.isSafeInteger(value.amountCents) ||
      value.amountCents < 0 || !value.pageId?.startsWith("gid://shopify/Page/") ||
      !/^[A-Z]{3}$/.test(value.currencyCode) ||
      !["credited", "cancelled"].includes(value.status)) {
    throw new Error("Invalid POS donation record; manual review required");
  }
  return value;
}

const orderQuery = `query posDonationOrder($id: ID!) {
  order(id: $id) {
    id name sourceName cancelledAt displayFinancialStatus
    ledger: metafield(namespace: "custom", key: "${LEDGER_KEY}") {
      value compareDigest
    }
  }
}`;

async function lineItems(orderId: string) {
  const items: PosLineItem[] = [];
  let after: string | null = null;
  do {
    const result: { order: { lineItems: {
      nodes: PosLineItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } | null } = await shopify(`query posDonationItems($id: ID!, $after: String) {
      order(id: $id) { lineItems(first: 250, after: $after) {
        nodes {
          title currentQuantity isGiftCard
          priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
          product { id }
        }
        pageInfo { hasNextPage endCursor }
      } }
    }`, { id: orderId, after });
    if (!result.order) throw new Error("POS order no longer exists");
    const connection = result.order.lineItems;
    items.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !after) {
      throw new Error("Missing POS line item pagination cursor");
    }
  } while (after);
  return items;
}

async function marbleFallsPageId() {
  let after: string | null = null;
  do {
    const result: { pages: {
      nodes: Array<{ id: string; handle: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } = await shopify(`query posDonationPage($after: String) {
      pages(first: 100, after: $after) {
        nodes { id handle }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after });
    const page = result.pages.nodes.find((p) => p.handle === "marble-falls");
    if (page) return page.id;
    after = result.pages.pageInfo.hasNextPage ? result.pages.pageInfo.endCursor : null;
    if (result.pages.pageInfo.hasNextPage && !after) {
      throw new Error("Missing page pagination cursor");
    }
  } while (after);
  throw new Error("Marble Falls page not found");
}

/** Returns null for online orders so their existing handler continues. */
export async function handlePosDonation(orderId: string, action: "credit" | "cancel") {
  // Re-read after a competing POS request changes the page/order digest.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { order } = await shopify<{ order: PosOrder | null }>(orderQuery, { id: orderId });
    if (!order || order.sourceName !== "pos") return null;
    const ledger = readLedger(order.ledger);
    const skip = (reason: string) => NextResponse.json({
      success: true, skipped: true, reason, orderId, orderName: order.name,
    });

    let nextLedger: Ledger;
    let eligibleSubtotalCents = 0;
    if (action === "cancel") {
      if (!order.cancelledAt) {
        return NextResponse.json({ success: false, error: "POS order is not cancelled" }, { status: 400 });
      }
      // Never deduct a guessed amount for an order this handler did not credit.
      if (!ledger || ledger.status === "cancelled") return skip("No credited POS donation to remove");
      nextLedger = { ...ledger, status: "cancelled" };
    } else {
      if (order.cancelledAt) return skip("POS order is cancelled");
      if (ledger) return skip("POS donation already processed");
      if (!["PAID", "PARTIALLY_REFUNDED"].includes(order.displayFinancialStatus)) {
        // A retry can process the order once payment finishes.
        return NextResponse.json({ success: false, error: "POS order payment is not complete" }, { status: 409 });
      }
      const items = await lineItems(orderId);
      const activeItems = items.filter((item) => item.currentQuantity > 0);
      const markers = activeItems.filter((item) => item.product?.id === MARBLE_FALLS_EVENT_PRODUCT_ID);
      if (!markers.length) return skip("No Marble Falls event product on POS order");
      if (activeItems.some((item) =>
        /^Swag Locker Event\s*\(/i.test(item.title) &&
        item.product?.id !== MARBLE_FALLS_EVENT_PRODUCT_ID
      )) {
        return NextResponse.json({ success: false, error: "Multiple school events on POS order; review required" }, { status: 422 });
      }
      const merchandise = activeItems.filter((item) =>
        item.product?.id !== MARBLE_FALLS_EVENT_PRODUCT_ID && !item.isGiftCard
      );
      const currencies = new Set(merchandise.map((i) =>
        i.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.currencyCode
      ));
      if (!merchandise.length) return skip("No merchandise on POS event order");
      if (currencies.size !== 1) throw new Error("POS donation currencies are inconsistent");
      eligibleSubtotalCents = merchandise.reduce((sum, item) => sum +
        cents(item.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount), 0);
      if (!Number.isSafeInteger(eligibleSubtotalCents)) throw new Error("POS subtotal is too large");
      // Net line amounts already include quantity and discounts, excluding tax.
      const amountCents = Math.round(eligibleSubtotalCents / 4);
      if (!amountCents) return skip("POS merchandise subtotal is zero");
      nextLedger = {
        version: 1, pageId: await marbleFallsPageId(), amountCents,
        currencyCode: [...currencies][0], status: "credited",
      };
    }

    const { page } = await shopify<{ page: { total: Metafield | null } | null }>(`
      query posDonationTotal($id: ID!) { page(id: $id) {
        total: metafield(namespace: "custom", key: "total_donations") { value compareDigest }
      } }
    `, { id: nextLedger.pageId });
    if (!page) throw new Error("Marble Falls donation page not found");
    let currentTotalCents = 0;
    if (page.total) {
      const money = JSON.parse(page.total.value) as { amount: string; currency_code: string };
      if (money.currency_code !== nextLedger.currencyCode) throw new Error("Page donation currency does not match POS order");
      currentTotalCents = cents(String(money.amount));
    }
    const delta = action === "credit" ? nextLedger.amountCents : -nextLedger.amountCents;
    const updatedTotalCents = currentTotalCents + delta;
    if (updatedTotalCents < 0 || !Number.isSafeInteger(updatedTotalCents)) {
      throw new Error("Page total cannot reconcile this POS donation; review required");
    }
    const result = await shopify<{ metafieldsSet: {
      userErrors: Array<{ code: string; message: string }>;
    } }>(`mutation posDonationSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { code message } }
    }`, {
      metafields: [
        {
          ownerId: nextLedger.pageId, namespace: "custom", key: "total_donations",
          type: "money", compareDigest: page.total?.compareDigest ?? null,
          value: JSON.stringify({ amount: (updatedTotalCents / 100).toFixed(2), currency_code: nextLedger.currencyCode }),
        },
        {
          ownerId: orderId, namespace: "custom", key: LEDGER_KEY,
          type: "json", compareDigest: order.ledger?.compareDigest ?? null,
          value: JSON.stringify(nextLedger),
        },
      ],
    });
    const errors = result.metafieldsSet.userErrors;
    if (errors.some((error) => error.code === "INVALID_COMPARE_DIGEST")) continue;
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
    // Shopify writes the page total and order receipt atomically. A Flow retry
    // after a lost HTTP response sees the receipt and does not add again.
    return NextResponse.json({
      success: true, orderId, orderName: order.name, source: "pos",
      ...(action === "credit"
        ? { eligibleSubtotal: (eligibleSubtotalCents / 100).toFixed(2), donationAmount: (nextLedger.amountCents / 100).toFixed(2) }
        : { removed: (nextLedger.amountCents / 100).toFixed(2) }),
      newTotal: (updatedTotalCents / 100).toFixed(2),
    });
  }
  return NextResponse.json({ success: false, error: "Donation total changed concurrently; retry request" }, { status: 409 });
}
