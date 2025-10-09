// src/app/api/replace-dummy/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderId, lineItems } = body;

    console.log("lineItems count:", lineItems.length);
    console.log("lineItems:", lineItems);

    const shopifyFetch = async (query: string, variables: any) => {
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
      return res.json();
    };

    // 1. Begin edit and fetch current calculated line items
    const beginRes = await shopifyFetch(
      `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 100) {
              edges {
                node {
                  id
                  variant { id sku }
                  quantity
                }
              }
            }
          }
          userErrors { field message }
        }
      }
      `,
      { id: orderId }
    );

    const calculatedOrder = beginRes.data?.orderEditBegin?.calculatedOrder;
    if (!calculatedOrder) {
      console.error("Failed to begin edit:", beginRes);
      return NextResponse.json({ error: "Failed to begin edit" }, { status: 500 });
    }

    const calculatedOrderId = calculatedOrder.id;
    const existingLineItems = calculatedOrder.lineItems?.edges || [];

    // 2a. Remove all existing line items (set qty = 0)
    for (const edge of existingLineItems) {
      const cli = edge.node;
      if (cli.quantity > 0) {
        const removeRes = await shopifyFetch(
          `
          mutation orderEditSetQuantity($calculatedOrderId: ID!, $lineItemId: ID!, $quantity: Int!) {
            orderEditSetQuantity(id: $calculatedOrderId, lineItemId: $lineItemId, quantity: $quantity) {
              calculatedOrder { id }
              userErrors { field message }
            }
          }
          `,
          { calculatedOrderId, lineItemId: cli.id, quantity: 0 }
        );
        console.log("Removed CLI:", cli.id, JSON.stringify(removeRes, null, 2));
      }
    }

    // 2b. Add the desired line items
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      console.log(`--- Adding LineItem ${i} ---`, item);

      const parts = item.sku.split(",");
      const tags = parts.map((p: string) => p.trim());

      // Extract size from variantTitle (e.g. "Black / Large" → "Large")
      const sizeParts = item.size ? item.size.split("/") : [];
      let size = sizeParts.length > 1 ? sizeParts[sizeParts.length - 1].trim() : item.size?.trim();

      const tagCandidate = tags.find((t: string) => t.includes("SIZE"));

      if (!tagCandidate) {
        console.warn("No SIZE tag found in sku:", item.sku);
        continue;
      }

      // ✅ If youth size (YXS, YS, YM, YL, YXL) → remove "Y"
      const youthSizes = ["YXS", "YS", "YM", "YL", "YXL"];
      if (size && youthSizes.includes(size.toUpperCase())) {
        size = size.substring(1); // remove the leading 'Y'
      }

      // Replace all occurrences of "SIZE" with the actual size value
      const resolvedSku = tagCandidate.replace(/SIZE/g, size);

      console.log("Resolved SKU:", resolvedSku);

      // Look up variant by SKU
      const variantRes = await shopifyFetch(
        `
        query($query: String!) {
          productVariants(first: 1, query: $query) {
            edges {
              node {
                id
                sku
                title
                product { title }
              }
            }
          }
        }
        `,
        { query: `sku:${resolvedSku}` }
      );

      const variant = variantRes.data?.productVariants?.edges?.[0]?.node;
      if (!variant) {
        console.error("No variant found for", resolvedSku);
        continue;
      }

      const variantId = variant.id;

      // Add variant
      const addRes = await shopifyFetch(
        `
        mutation orderEditAddVariant($calculatedOrderId: ID!, $variantId: ID!, $quantity: Int!) {
          orderEditAddVariant(id: $calculatedOrderId, variantId: $variantId, quantity: $quantity) {
            calculatedOrder {
              id
              addedLineItems(first: 5) {
                edges {
                  node {
                    id
                    variant { id title sku }
                    quantity
                  }
                }
              }
            }
            userErrors { field message }
          }
        }
        `,
        { calculatedOrderId, variantId, quantity: item.quantity || 1 }
      );

      console.log("Add variant response:", JSON.stringify(addRes, null, 2));
    }

    // 3. Commit edit
    const commitRes = await shopifyFetch(
      `
      mutation orderEditCommit($calculatedOrderId: ID!) {
        orderEditCommit(id: $calculatedOrderId) {
          order {
            id
            name
            lineItems(first: 20) {
              edges { node { id title quantity } }
            }
          }
          userErrors { field message }
        }
      }
      `,
      { calculatedOrderId }
    );

    console.log("Commit response:", JSON.stringify(commitRes, null, 2));

    return NextResponse.json({ success: true, commitRes });
  } catch (err) {
    console.error("Error in /api/replace-dummy:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}