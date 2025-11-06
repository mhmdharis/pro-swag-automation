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

    // Filter ProSwag vendor items & calculate subtotal
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

    // Convert GID → numeric order ID
    //const numericOrderId = orderId.split("/").pop();

    // Get metafield custom.total_donations
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
    console.log(donationField)
    const currentDonation = donationField ? parseFloat(JSON.parse(donationField.value).amount) : 0;
    console.log(currentDonation)
    const updatedDonation = Math.max(currentDonation - donationAmount, 0); // prevent negative values

    console.log("Updated donation total:", updatedDonation);

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/metafields/${donationField.id}.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metafield: {
            id: donationField.id,
            owner_id: donationField.owner_id,
            owner_resource: "page",
            type: "money",
            value: updatedDonation.toFixed(2)
          },
        }),
      }
    );

    const result = await response.json();
    console.log("Metafield Update Result:", result);


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