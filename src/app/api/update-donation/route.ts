import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    console.log("🧾 Received update-donation body:", JSON.stringify(body, null, 2));

    // Extract orderTotal (if available)
    const orderTotal = parseFloat(body.orderTotal);
    console.log("💰 Parsed orderTotal:", orderTotal);

    // You can later add logic to update the metafield here
    // For now, we just return what was received
    return NextResponse.json({
      success: true,
      message: "Received donation update payload",
      received: body,
      parsedOrderTotal: orderTotal,
    });
  } catch (err) {
    console.error("❌ Error in /api/update-donation:", err);
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}