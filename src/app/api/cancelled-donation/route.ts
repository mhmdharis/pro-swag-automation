import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Order Cancelled Payload Received:", body);

    const { orderId, lineItems } = body;
    if (!orderId || !lineItems) {
      return NextResponse.json({ success: false, error: "Missing fields" }, { status: 400 });
    }

    type LineItem = {
      vendor?: string;
      price?: string;
      quantity?: number | string;
    };

    // ✅ Filter ProSwag vendor items & calculate subtotal
    const proSwagTotal = lineItems.reduce((sum: number, li: LineItem) => {
      if (li.vendor === "ProSwag") {
        const price = parseFloat(li.price ?? "0");
        const qty = Number(li.quantity ?? 1);
        sum += price * qty;
      }
      return sum;
    }, 0);

    const donationAmount = proSwagTotal * 0.25;

    console.log("Donation amount to subtract:", donationAmount);

    // ✅ Convert GID → numeric order ID
    //const numericOrderId = orderId.split("/").pop();

    // ✅ Get metafield custom.total_donations
    const metafieldRes = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/pages/154228228390/metafields.json`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
          "Content-Type": "application/json",
        },
      }
    );

    const { metafields } = await metafieldRes.json();
    const donationField = metafields.find((m: any) => m.key === "total_donations" && m.namespace === "custom");

    const currentDonation = donationField ? parseFloat(donationField.value) : 0;
    const updatedDonation = Math.max(currentDonation - donationAmount, 0); // ✅ prevent negative values

    console.log("Updated donation total:", updatedDonation);

    // ✅ Update metafield
    await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-07/metafields/${donationField.id}.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metafield: {
            id: donationField.id,
            value: updatedDonation.toFixed(2),
            type: "money",
          },
        }),
      }
    );

    return NextResponse.json({
      success: true,
      originalDonation: currentDonation,
      updatedDonation,
      removed: donationAmount,
    });

  } catch (error) {
    console.error("Handler error:", error);
    return NextResponse.json({ success: false, error: "Processing failed" }, { status: 500 });
  }
}