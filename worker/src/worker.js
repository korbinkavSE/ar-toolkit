const ALLOWED_ORIGIN = 'https://korbinkavse.github.io';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (pathname === '/pdf') {
      return handlePdf(request, env);
    }

    if (pathname === '/token') {
      return handleToken(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handlePdf(request, env) {
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
}

async function handleToken(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400, headers: corsHeaders });
  }

  // Add the client secret server-side; reject if browser tried to send one
  const params = new URLSearchParams({
    code: body.code,
    client_id: body.client_id,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: body.redirect_uri,
    grant_type: 'authorization_code',
    code_verifier: body.code_verifier,
  });

  const upstream = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await upstream.json();
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
