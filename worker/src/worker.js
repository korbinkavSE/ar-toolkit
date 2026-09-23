const ALLOWED_ORIGIN = 'https://korbinkavse.github.io';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON body', { status: 400, headers: corsHeaders });
    }

    const upstream = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': env.PDFSHIFT_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }

    const pdf = await upstream.arrayBuffer();
    return new Response(pdf, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/pdf' },
    });
  },
};
