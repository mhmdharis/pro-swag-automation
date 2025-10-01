// app/api/shopify-order/route.ts
export async function POST(req: Request) {
  try {
    const body = await req.json();

    console.log('--- Shopify webhook received ---');
    console.log('Raw body:', JSON.stringify(body, null, 2));

    const items = Array.isArray(body.lineItems) ? body.lineItems : [];
    console.log(`lineItems count: ${items.length}`);

    items.forEach((li: any, idx: number) => {
      const id = li.id;
      const skuRaw = li.sku || ''; // in your payload this is product.tags joined by ','
      const size = li.size || li.variantTitle || 'UNKNOWN';
      const tags = skuRaw.split(',').map((t: string) => t.trim()).filter(Boolean);
      const tagCandidate = tags.find((t: string) => /-SIZE$/i.test(t)); // tag like PS310G-22-SIZE
      const resolvedSku = tagCandidate ? tagCandidate.replace(/-SIZE$/i, `-${size}`) : null;

      console.log(`--- LineItem ${idx} ---`);
      console.log('id:', id);
      console.log('skuRaw:', skuRaw);
      console.log('parsed tags:', tags);
      console.log('size:', size);
      console.log('tagCandidate (ends with -SIZE):', tagCandidate);
      console.log('resolved SKU (replace SIZE with size):', resolvedSku);
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('error parsing webhook', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}