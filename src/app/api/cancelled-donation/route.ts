import { NextResponse } from "next/server";

const SHOPIFY_API_VERSION = "2026-07";
const MARBLE_FALLS_COLLECTION_TITLE =
  "Marble Falls Mustangs Athletics Apparel & Fan Gear";

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type DonationLineItem = {
  title: string;
  sku: string | null;
  originalTotalSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  product: {
    collections: {
      nodes: Array<{ title: string }>;
    };
  } | null;
};

async function shopifyFetch<T>(
  query: string,
  variables: Record<string, unknown> = {}
) {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_API_TOKEN;

  if (!storeDomain || !accessToken) {
    throw new Error("Shopify configuration is missing");
  }

  const response = await fetch(
    `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const result = (await response.json()) as GraphqlResponse<T>;

  if (!response.ok) {
    throw new Error(`Shopify request failed with status ${response.status}`);
  }

  if (result.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${result.errors
        .map((error) => error.message ?? "Unknown error")
        .join("; ")}`
    );
  }

  return result.data;
}

function normalizeOrderId(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const orderId = value.trim();
  return orderId.startsWith("gid://shopify/Order/")
    ? orderId
    : /^\d+$/.test(orderId)
      ? `gid://shopify/Order/${orderId}`
      : null;
}

function moneyToCents(amount: string) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    throw new Error(`Invalid Shopify money amount: ${amount}`);
  }

  return Math.round(numericAmount * 100);
}

function readMoneyMetafield(value: string | undefined) {
  if (!value) return 0;

  try {
    const parsed = JSON.parse(value) as { amount?: unknown };
    const amount = Number(parsed.amount);
    return Number.isFinite(amount) ? amount : 0;
  } catch {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { orderId?: unknown };
    const orderId = normalizeOrderId(body.orderId);

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: "A valid Shopify orderId is required" },
        { status: 400 }
      );
    }

    const orderData = await shopifyFetch<{
      order: {
        id: string;
        name: string;
        lineItems: { nodes: DonationLineItem[] };
      } | null;
    }>(
      `
        query getCancelledDonationOrder(
          $id: ID!
          $collectionQuery: String!
        ) {
          order(id: $id) {
            id
            name
            lineItems(first: 250) {
              nodes {
                title
                sku
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                product {
                  collections(first: 1, query: $collectionQuery) {
                    nodes {
                      title
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        id: orderId,
        collectionQuery: `title:\"${MARBLE_FALLS_COLLECTION_TITLE}\"`,
      }
    );

    if (!orderData?.order) {
      return NextResponse.json(
        { success: false, error: "Shopify order not found" },
        { status: 404 }
      );
    }

    const targetCollectionTitle = MARBLE_FALLS_COLLECTION_TITLE.toLowerCase();
    const eligibleItems = orderData.order.lineItems.nodes.filter((lineItem) =>
      lineItem.product?.collections.nodes.some(
        (collection) => collection.title.toLowerCase() === targetCollectionTitle
      )
    );

    if (eligibleItems.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Order has no products in ${MARBLE_FALLS_COLLECTION_TITLE}`,
        },
        { status: 400 }
      );
    }

    const currencies = new Set(
      eligibleItems.map(
        (lineItem) =>
          lineItem.originalTotalSet.shopMoney.currencyCode
      )
    );

    if (currencies.size !== 1) {
      throw new Error("Eligible line items use inconsistent currencies");
    }

    const currencyCode = [...currencies][0];
    const eligibleSubtotalCents = eligibleItems.reduce(
      (total, lineItem) =>
        total +
        moneyToCents(
          lineItem.originalTotalSet.shopMoney.amount
        ),
      0
    );
    const donationCents = Math.round(eligibleSubtotalCents * 0.25);

    const pageData = await shopifyFetch<{
      pages: { nodes: Array<{ id: string; title: string }> };
    }>(`
      query getMarbleFallsPage {
        pages(first: 100) {
          nodes {
            id
            title
          }
        }
      }
    `);

    const marblePage = pageData?.pages.nodes.find((page) => {
      const title = page.title.toLowerCase();
      return title.includes("marble") && title.includes("falls");
    });

    if (!marblePage) {
      return NextResponse.json(
        { success: false, error: "Marble Falls page not found" },
        { status: 404 }
      );
    }

    const metafieldData = await shopifyFetch<{
      page: {
        metafields: {
          nodes: Array<{ key: string; value: string }>;
        };
      } | null;
    }>(
      `
        query getPageMetafields($id: ID!) {
          page(id: $id) {
            metafields(first: 10, namespace: "custom") {
              nodes {
                key
                value
              }
            }
          }
        }
      `,
      { id: marblePage.id }
    );

    const existingField = metafieldData?.page?.metafields.nodes.find(
      (metafield) => metafield.key === "total_donations"
    );
    const currentTotalCents = Math.round(
      readMoneyMetafield(existingField?.value) * 100
    );
    const updatedTotalCents = Math.max(currentTotalCents - donationCents, 0);

    const mutationData = await shopifyFetch<{
      metafieldsSet: {
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(
      `
        mutation setDonationMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        metafields: [
          {
            namespace: "custom",
            key: "total_donations",
            type: "money",
            value: JSON.stringify({
              amount: (updatedTotalCents / 100).toFixed(2),
              currency_code: currencyCode,
            }),
            ownerId: marblePage.id,
          },
        ],
      }
    );

    const userErrors = mutationData?.metafieldsSet.userErrors ?? [];
    if (userErrors.length > 0) {
      return NextResponse.json(
        { success: false, errors: userErrors },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Cancelled-order donation removed successfully",
      orderId: orderData.order.id,
      orderName: orderData.order.name,
      eligibleSubtotal: (eligibleSubtotalCents / 100).toFixed(2),
      removed: (donationCents / 100).toFixed(2),
      originalTotal: (currentTotalCents / 100).toFixed(2),
      updatedTotal: (updatedTotalCents / 100).toFixed(2),
      matchedItems: eligibleItems.map((lineItem) => ({
        title: lineItem.title,
        sku: lineItem.sku,
        subtotal:
          lineItem.originalTotalSet.shopMoney.amount,
      })),
    });
  } catch (error) {
    console.error("Error in /api/cancelled-donation:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Processing failed",
      },
      { status: 500 }
    );
  }
}
