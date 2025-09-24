export async function POST(req: Request) {
  const body = await req.json();
  console.log("🔹Incoming from Shopify Flow:", body); // 👈 check payload

  const { orderId, lineItemId, sku, size } = body;

  console.log("orderId:", orderId);
  console.log("lineItemId:", lineItemId);
  console.log("sku:", sku);
  console.log("size:", size);

  return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
}