// debug handler snippet (TypeScript)
export async function POST(req: Request) {
  const body = await req.json();
  console.log("🔹 Incoming from Shopify Flow:", JSON.stringify(body, null, 2));
  const { orderId, lineItems } = body;

  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_API_TOKEN) {
    console.error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_TOKEN");
    return new Response("Missing env", { status: 500 });
  }

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
    console.log("📡 Shopify raw response:", JSON.stringify(json, null, 2));
    return json;
  }

  async function findVariantIdBySize(productTag: string, size: string) {
    // if productTag contains commas, use first tag
    const tag = (productTag || "").split(",")[0].trim().replace(/"/g, '\\"');
    const searchQuery = `tag:"${tag}"`;
    const query = `
      query getProductByTag($query: String!) {
        products(first: 5, query: $query) {
          edges { node { id title handle variants(first:50) { edges { node { id title sku } } } } }
        }
      }`;
    const json = await callShopify(query, { query: searchQuery });
    const products = json?.data?.products?.edges || [];
    if (products.length === 0) {
      throw new Error(`No product found for tag "${tag}" (search: ${searchQuery})`);
    }
    // Try to find a matching variant title
    for (const pEdge of products) {
      const variants = pEdge.node.variants.edges || [];
      const match = variants.find((v: any) => v.node.title === size || v.node.sku === size);
      if (match) return match.node.id;
    }
    // Return first variant as fallback (but log)
    console.warn("No exact variant match found. Showing first product/variants for debugging.");
    console.log(JSON.stringify(products, null, 2));
    throw new Error(`No variant found for size ${size}`);
  }

  for (const item of lineItems) {
    console.log(`➡️ Processing line item ${item.id} (size: ${item.size}, sku/tags: ${item.sku})`);

    // 1) Begin edit
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
          userErrors { field message }
        }
      }`;
    const beginJson = await callShopify(beginEditMutation, { id: orderId });
    if (beginJson.errors || beginJson.data?.orderEditBegin?.userErrors?.length) {
      console.error("❌ beginEdit errors:", JSON.stringify(beginJson.errors || beginJson.data.orderEditBegin.userErrors, null, 2));
      continue;
    }
    const calculatedOrder = beginJson?.data?.orderEditBegin?.calculatedOrder;
    if (!calculatedOrder) {
      console.error("❌ No calculatedOrder in begin response", JSON.stringify(beginJson, null, 2));
      continue;
    }
    const calculatedOrderId = calculatedOrder.id;
    const draftLineItems = calculatedOrder.lineItems?.edges || [];
    console.log("draftLineItems count:", draftLineItems.length);

    // Map original -> calculated
    const mapping: Record<string, string> = {};
    for (const edge of draftLineItems) {
      const orig = edge.node.originalLineItem?.id;
      const calc = edge.node.id;
      console.log(`draft edge: orig=${orig} -> calc=${calc}`);
      if (orig) mapping[orig] = calc;
    }

    const calculatedLineItemId = mapping[item.id];
    if (!calculatedLineItemId) {
      console.error(`❌ Could not find calculated line item for original ${item.id}`);
      console.error("Mapping keys:", Object.keys(mapping));
      continue;
    }

    // 2) Remove
    const removeMutation = `
      mutation removeLine($calculatedOrderId: ID!, $lineId: ID!) {
        orderEditSetQuantity(id: $calculatedOrderId, quantity: 0, lineItemId: $lineId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`;
    const removeJson = await callShopify(removeMutation, { calculatedOrderId, lineId: calculatedLineItemId });
    if (removeJson.errors || removeJson.data?.orderEditSetQuantity?.userErrors?.length) {
      console.error("❌ remove error:", JSON.stringify(removeJson.errors || removeJson.data.orderEditSetQuantity.userErrors, null, 2));
      continue;
    }
    console.log(`🗑️ Removed line item: ${item.id} (calculated id: ${calculatedLineItemId})`);

    // 3) Add variant
    let newVariantId;
    try {
      newVariantId = await findVariantIdBySize(item.sku, item.size);
    } catch (err) {
      const error = err as Error;
      console.error("❌ findVariantIdBySize failed:", error.message || err);
      continue;
    }
    const addMutation = `
      mutation addVariant($calculatedOrderId: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $calculatedOrderId, variantId: $variantId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`;
    const addJson = await callShopify(addMutation, { calculatedOrderId, variantId: newVariantId, quantity: 1 });
    if (addJson.errors || addJson.data?.orderEditAddVariant?.userErrors?.length) {
      console.error("❌ addVariant error:", JSON.stringify(addJson.errors || addJson.data.orderEditAddVariant.userErrors, null, 2));
      continue;
    }
    console.log(`➕ Added variant ${newVariantId} (size: ${item.size})`);

    // 4) Commit
    const commitMutation = `
      mutation commitEdit($id: ID!) {
        orderEditCommit(id: $id) {
          order { id name }
          userErrors { field message }
        }
      }`;
    const commitJson = await callShopify(commitMutation, { id: calculatedOrderId });
    if (commitJson.errors || commitJson.data?.orderEditCommit?.userErrors?.length) {
      console.error("❌ commit error:", JSON.stringify(commitJson.errors || commitJson.data.orderEditCommit.userErrors, null, 2));
      continue;
    }
    console.log("✅ Order edit committed:", commitJson.data.orderEditCommit.order);
  }

  return new Response(JSON.stringify({ message: "Done (debug mode)" }), { status: 200 });
}