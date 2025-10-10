import { NextResponse } from "next/server";

// Helper for making Shopify GraphQL calls
async function shopifyFetch(query: string, variables: any = {}) {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const data = await res.json();
  return data;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Received update-donation body:", JSON.stringify(body, null, 2));

    const orderTotal = parseFloat(body.orderTotal);
    if (isNaN(orderTotal)) {
      return NextResponse.json({ error: "Invalid orderTotal" }, { status: 400 });
    }

    const donationAmount = orderTotal * 0.25;
    console.log("Order total:", orderTotal, "→ Donation (25%):", donationAmount);

    // 1️ Fetch Marble Falls page by title
    const pageRes = await shopifyFetch(
      `
      {
        pages(first: 100) {
          edges {
            node { id title }
          }
        }
      }
      `
    );

    const marblePage = pageRes.data.pages.edges.find(
      (edge: any) =>
        edge.node.title.toLowerCase().includes("marble") &&
        edge.node.title.toLowerCase().includes("falls")
    );

    if (!marblePage) {
      console.error("Marble Falls page not found");
      return NextResponse.json({ error: "Marble Falls page not found" }, { status: 404 });
    }

    const pageId = marblePage.node.id;
    console.log("Found Marble Falls page:", marblePage.node.title, pageId);

    // 2️ Fetch current metafield value
    const metafieldRes = await shopifyFetch(
      `
      query getPageMetafield($ownerId: ID!) {
        metafields(first: 10, ownerId: $ownerId, namespace: "custom") {
          edges {
            node {
              id
              namespace
              key
              value
            }
          }
        }
      }
      `,
      { ownerId: pageId }
    );

    const existingField = metafieldRes.data.metafields.edges.find(
      (edge: any) => edge.node.key === "total_donations"
    );

    const existingValue = existingField ? parseFloat(existingField.node.value) : 0;
    const newTotal = existingValue + donationAmount;

    console.log(`Existing total: ${existingValue} → New total: ${newTotal}`);

    // 3️ Create or update metafield
    const saveRes = await shopifyFetch(
      `
      mutation upsertMetafield($input: MetafieldInput!) {
        metafieldUpsert(input: $input) {
          metafield {
            id
            key
            namespace
            value
            type
          }
          userErrors { field message }
        }
      }
      `,
      {
        input: {
          namespace: "custom",
          key: "total_donations",
          type: "number_decimal",
          value: newTotal.toFixed(2),
          ownerId: pageId,
        },
      }
    );

    console.log("Metafield update response:", JSON.stringify(saveRes, null, 2));

    return NextResponse.json({
      success: true,
      message: "Donation updated successfully",
      newTotal,
    });
  } catch (err) {
    console.error("Error in /api/update-donation:", err);
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}