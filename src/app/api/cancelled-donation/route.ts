import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Order Cancelled Payload Received:", body);

    // 👉 You can store this data in a DB or logging service here

    return NextResponse.json({
      success: true,
      message: "Order cancelled webhook logged",
      received: body,
    });
  } catch (error) {
    console.error("Error parsing request:", error);

    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }
}

export function GET() {
  return NextResponse.json({ status: "OK" });
}