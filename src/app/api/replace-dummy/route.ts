// src/app/api/replace-dummy/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderId, lineItems } = body;

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

    // 🧩 1. Pre-resolve all Marble Falls SKUs that should be modified
    const resolvedSkuList: string[] = [];

    for (const item of lineItems) {
      const parts = item.sku.split(",");
      const tags = parts.map((p: string) => p.trim());
      const sizeParts = item.size ? item.size.split("/") : [];
      let size =
        sizeParts.length > 1
          ? sizeParts[sizeParts.length - 1].trim()
          : item.size?.trim();

      const tagCandidate = tags.find((t: string) => t.includes("SIZE"));
      if (!tagCandidate) continue;

      const youthSizes = ["YXS", "YS", "YM", "YL", "YXL"];
      if (size && youthSizes.includes(size.toUpperCase())) {
        size = size.substring(1); // remove 'Y'
      }

      const resolvedSku = tagCandidate.replace(/SIZE/g, size);
      resolvedSkuList.push(resolvedSku);
    }

    console.log("Resolved Marble Falls SKUs:", resolvedSkuList);

    // 🧩 2. Begin edit and fetch order line items
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

    // 🧩 3. Set quantity = 0 only for matching SKUs or product tags (Marble Falls)
    for (const edge of existingLineItems) {
      const cli = edge.node;
      const variantId = cli.variant?.id;
      const sku = cli.variant?.sku;
      let matchFound = false;

      if (cli.quantity <= 0) continue;

      if (sku) {
        // Case 1: Variant has a SKU → direct match
        if (resolvedSkuList.includes(sku)) {
          matchFound = true;
          console.log(`Matched by SKU: ${sku}`);
        }
      } else if (variantId) {
        // Case 2: SKU is null → fetch product tags via variant ID
        const variantRes = await shopifyFetch(
          `
          query getProductTagsFromVariant($variantId: ID!) {
            productVariant(id: $variantId) {
              id
              product {
                id
                title
                tags
              }
            }
          }
          `,
          { variantId }
        );

        const tags = variantRes.data?.productVariant?.product?.tags || [];
        if (tags.some((tag: string) => resolvedSkuList.includes(tag))) {
          matchFound = true;
          console.log(
            `Matched by product tags for variant ${variantId}:`,
            tags
          );
        }
      }

      // 🧹 Set quantity to 0 only for matched Marble Falls items
      if (matchFound) {
        console.log(`Setting quantity 0 for Marble Falls item...`);

        const removeRes = await shopifyFetch(
          `
          mutation orderEditSetQuantity(
            $calculatedOrderId: ID!,
            $lineItemId: ID!,
            $quantity: Int!
          ) {
            orderEditSetQuantity(
              id: $calculatedOrderId,
              lineItemId: $lineItemId,
              quantity: $quantity
            ) {
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

    // 🧩 4. Add the resolved Marble Falls variants (same logic as before)
    for (const item of lineItems) {
      const parts = item.sku.split(",");
      const tags = parts.map((p: string) => p.trim());
      const sizeParts = item.size ? item.size.split("/") : [];
      let size =
        sizeParts.length > 1
          ? sizeParts[sizeParts.length - 1].trim()
          : item.size?.trim();

      const tagCandidate = tags.find((t: string) => t.includes("SIZE"));
      if (!tagCandidate) continue;

      const youthSizes = ["YXS", "YS", "YM", "YL", "YXL"];
      if (size && youthSizes.includes(size.toUpperCase())) {
        size = size.substring(1);
      }

      const resolvedSku = tagCandidate.replace(/SIZE/g, size);
      console.log("Resolved SKU to add:", resolvedSku);

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

      const addRes = await shopifyFetch(
        `
        mutation orderEditAddVariant(
          $calculatedOrderId: ID!,
          $variantId: ID!,
          $quantity: Int!
        ) {
          orderEditAddVariant(
            id: $calculatedOrderId,
            variantId: $variantId,
            quantity: $quantity
          ) {
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
        { calculatedOrderId, variantId: variant.id, quantity: item.quantity || 1 }
      );

      console.log("Added variant response:", JSON.stringify(addRes, null, 2));
    }

    // 🧩 5. Commit edit
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