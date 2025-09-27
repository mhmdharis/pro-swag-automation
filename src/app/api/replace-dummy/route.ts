export async function POST(req: Request) {
  const body = await req.json();
  console.log("🔹 Incoming from Shopify Flow:", JSON.stringify(body, null, 2));

  const { orderId, lineItems } = body;

  const shopifyEndpoint = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
  };

  async function callShopify(query: string, variables: any = {}) {
    const res = await fetch(shopifyEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) console.error("GraphQL Errors:", json.errors);
    return json.data;
  }

  for (const item of lineItems) {
    console.log(`➡️ Processing line item ${item.id} (size: ${item.size})`);

    // -----------------------------
    // 1. Begin an order edit
    // -----------------------------
    const beginEditMutation = `
      mutation beginEdit($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 50) {
              edges {
                node {
                  id
                  originalLineItem { id }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`;
    const beginData = await callShopify(beginEditMutation, { id: orderId });
    const calculatedOrderId = beginData?.orderEditBegin?.calculatedOrder?.id;
    const calculatedLineItems =
      beginData?.orderEditBegin?.calculatedOrder?.lineItems?.edges || [];

    if (!calculatedOrderId) {
      console.error("❌ Could not begin order edit:", beginData);
      continue;
    }
    console.log("🆕 Calculated order ID:", calculatedOrderId);

    // Build a map original lineItemId → calculated lineItemId
    const lineItemMap = new Map(
      calculatedLineItems.map((edge: any) => [
        edge.node.originalLineItem.id,
        edge.node.id,
      ])
    );

    const calcLineItemId = lineItemMap.get(item.id);
    if (!calcLineItemId) {
      console.error(`❌ No calculated line item found for ${item.id}`);
      continue;
    }

    // -----------------------------
    // 2. Remove the existing line item
    // -----------------------------
    const removeMutation = `
      mutation removeLine($calculatedOrderId: ID!, $lineId: ID!) {
        orderEditSetQuantity(id: $calculatedOrderId, quantity: 0, lineItemId: $lineId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`;
    await callShopify(removeMutation, {
      calculatedOrderId,
      lineId: calcLineItemId,
    });
    console.log(`🗑️ Removed line item: ${calcLineItemId}`);

    // -----------------------------
    // 3. Add the new variant
    // -----------------------------
    const newVariantId = await findVariantIdBySize(item.sku, item.size);

    const addMutation = `
      mutation addVariant($calculatedOrderId: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $calculatedOrderId, variantId: $variantId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`;
    await callShopify(addMutation, {
      calculatedOrderId,
      variantId: newVariantId,
      quantity: 1,
    });
    console.log(`➕ Added variant ${newVariantId} (size: ${item.size})`);

    // -----------------------------
    // 4. Commit the order edit
    // -----------------------------
    const commitMutation = `
      mutation commitEdit($id: ID!) {
        orderEditCommit(id: $id) {
          order { id name }
          userErrors { field message }
        }
      }`;
    await callShopify(commitMutation, { id: calculatedOrderId });
    console.log("✅ Order edit committed.");
  }

  return new Response(JSON.stringify({ message: "Order updated" }), {
    status: 200,
  });
}

// -----------------------------
// Helper: look up a variant ID by product tags + size
// -----------------------------
async function findVariantIdBySize(productTag: string, size: string) {
  const shopifyEndpoint = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
  };

  const query = `
    query getProductByTag($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }`;

  const res = await fetch(shopifyEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query, // GraphQL query string
      variables: {
        query: `tag:${productTag}`, // GraphQL variable "query"
      },
    }),
  });

  const json = await res.json();

  const variants =
    json?.data?.products?.edges?.[0]?.node?.variants?.edges || [];
  const match = variants.find((v: any) => v.node.title === size);

  if (!match) {
    throw new Error(`No variant found for size ${size}`);
  }

  return match.node.id;
}