export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("🔹Incoming from Shopify Flow:", JSON.stringify(body, null, 2));

    const { orderId, lineItems } = body;

    console.log("🆔 Order ID:", orderId);

    if (Array.isArray(lineItems)) {
      console.log(`📦 Received ${lineItems.length} line item(s):`);
      lineItems.forEach((item: any, index: number) => {
        console.log(
          `#${index + 1}: id=${item.id} | sku=${item.sku} | size=${item.size}`
        );
      });
    } else {
      console.log("⚠️ No lineItems array found in request body");
    }

    return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
  } catch (err: any) {
    console.error("❌ Error parsing request:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }
}