const ALLOWED_ORIGIN = 'https://korbinkavse.github.io';
const AT_BASE = 'https://api.airtable.com/v0';
const BASE_ID = 'appk8z59VBuLT9ndp';

// Logo URL (hosted on GitHub Pages alongside the app)
const LOGO_URL = 'https://korbinkavse.github.io/ar-toolkit-new/logo.png';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const apiCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const h = pathname.startsWith('/api/') ? apiCorsHeaders : corsHeaders;
      return new Response(null, { status: 204, headers: h });
    }

    // GrokBot API routes — authenticated by AGENT_API_KEY, any origin
    if (pathname.startsWith('/api/')) {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.AGENT_API_KEY}`) {
        return new Response('Unauthorized', { status: 401, headers: apiCorsHeaders });
      }
      if (pathname === '/api/clients' && request.method === 'GET') return handleApiClients(env);
      if (pathname === '/api/invoices' && request.method === 'GET') return handleApiInvoices(request, env);
      if (pathname === '/api/log' && request.method === 'POST') return handleApiLog(request, env);
      if (pathname === '/api/statement' && request.method === 'POST') return handleApiStatement(request, env);
      return new Response('Not Found', { status: 404, headers: apiCorsHeaders });
    }

    // Existing UI proxy routes — restricted to GitHub Pages origin
    if (origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    if (pathname === '/pdf') return handlePdf(request, env);
    if (pathname === '/token') return handleToken(request, env);
    return new Response('Not Found', { status: 404 });
  },
};

// ── Airtable helper ──────────────────────────────────────────────────────────

async function atFetch(env, path) {
  const res = await fetch(`${AT_BASE}/${BASE_ID}/${path}`, {
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
  });
  return res.json();
}

async function atPost(env, table, fields) {
  const res = await fetch(`${AT_BASE}/${BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

async function atFetchAll(env, table, params) {
  let records = [];
  let offset = '';
  do {
    const qs = params + (offset ? `&offset=${offset}` : '');
    const data = await atFetch(env, `${encodeURIComponent(table)}?${qs}`);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    records = records.concat(data.records || []);
    offset = data.offset || '';
  } while (offset);
  return records;
}

// ── GET /api/clients ─────────────────────────────────────────────────────────

async function handleApiClients(env) {
  try {
    const statusFilter = encodeURIComponent(`OR({Status}="Unpaid",{Status}="Partially Paid")`);
    const invoices = await atFetchAll(env, 'Invoices',
      `filterByFormula=${statusFilter}&fields[]=Client&fields[]=Balance+Due`);

    const clientIds = new Set();
    invoices.forEach(r => (r.fields['Client'] || []).forEach(id => clientIds.add(id)));

    const clientNames = {};
    const idArr = [...clientIds];
    for (let i = 0; i < idArr.length; i += 100) {
      const batch = idArr.slice(i, i + 100);
      const f = encodeURIComponent(`OR(${batch.map(id => `RECORD_ID()="${id}"`).join(',')})`);
      const data = await atFetch(env, `Clients?filterByFormula=${f}&fields[]=Client+Name`);
      (data.records || []).forEach(r => { clientNames[r.id] = r.fields['Client Name'] || r.id; });
    }

    const totals = {};
    invoices.forEach(r => {
      const ids = r.fields['Client'] || [];
      const bal = parseFloat(r.fields['Balance Due'] || 0);
      ids.forEach(id => {
        const name = clientNames[id] || id;
        if (!totals[name]) totals[name] = 0;
        totals[name] += bal;
      });
    });

    const clients = Object.entries(totals)
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    return new Response(JSON.stringify({ clients }), {
      status: 200, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── GET /api/invoices?client=Name ────────────────────────────────────────────

async function handleApiInvoices(request, env) {
  try {
    const url = new URL(request.url);
    const clientName = url.searchParams.get('client');
    if (!clientName) return new Response(JSON.stringify({ error: 'client param required' }), {
      status: 400, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });

    // Look up client record ID
    const cf = encodeURIComponent(`{Client Name}="${clientName}"`);
    const cdata = await atFetch(env, `Clients?filterByFormula=${cf}&fields[]=Client+Name`);
    const clientRec = (cdata.records || [])[0];
    if (!clientRec) return new Response(JSON.stringify({ error: 'Client not found' }), {
      status: 404, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });

    const clientId = clientRec.id;
    const statusFilter = encodeURIComponent(`AND(OR({Status}="Unpaid",{Status}="Partially Paid"),FIND("${clientId}",ARRAYJOIN({Client})))`);
    const invoices = await atFetchAll(env, 'Invoices',
      `filterByFormula=${statusFilter}&fields[]=Invoice+Number&fields[]=Balance+Due&fields[]=Due+Date&fields[]=Days+Overdue&fields[]=Projects`);

    const projectIds = new Set();
    invoices.forEach(r => (r.fields['Projects'] || []).forEach(id => projectIds.add(id)));
    const projectNames = {};
    const pidArr = [...projectIds];
    for (let i = 0; i < pidArr.length; i += 100) {
      const batch = pidArr.slice(i, i + 100);
      const f = encodeURIComponent(`OR(${batch.map(id => `RECORD_ID()="${id}"`).join(',')})`);
      const data = await atFetch(env, `Projects?filterByFormula=${f}&fields[]=Project+Name&fields[]=Project+Code`);
      (data.records || []).forEach(r => { projectNames[r.id] = r.fields['Project Name'] || r.fields['Project Code'] || r.id; });
    }

    const today = new Date();
    const result = invoices.map(r => {
      const f = r.fields;
      const due = f['Due Date'] || '';
      let daysOverdue = parseInt(f['Days Overdue'] || 0);
      if (due && !daysOverdue) {
        daysOverdue = Math.max(0, Math.floor((today - new Date(due)) / 86400000));
      }
      const projIds = f['Projects'] || [];
      const project = projIds.length ? (projectNames[projIds[0]] || projIds[0]) : '';
      return {
        id: r.id,
        invNum: String(f['Invoice Number'] || ''),
        balance: parseFloat(f['Balance Due'] || 0),
        due,
        daysOverdue,
        project,
      };
    }).filter(i => i.balance > 0).sort((a, b) => a.invNum.localeCompare(b.invNum));

    const total = result.reduce((s, i) => s + i.balance, 0);
    return new Response(JSON.stringify({ client: clientName, total: Math.round(total * 100) / 100, invoices: result }), {
      status: 200, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── POST /api/log ─────────────────────────────────────────────────────────────
// Body: { action, notes, contactId?, invoiceIds?, nextSteps?, nextStepDue?, performedBy? }

async function handleApiLog(request, env) {
  try {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: apiCorsHeaders }); }

    const fields = {};
    fields['Date'] = new Date().toISOString().split('T')[0];
    if (body.action) fields['Action Taken'] = body.action;
    if (body.notes) fields['Notes'] = body.notes;
    if (body.contactId) fields['Client Contact'] = [body.contactId];
    if (Array.isArray(body.invoiceIds) && body.invoiceIds.length) fields['Invoices'] = body.invoiceIds;
    if (body.nextSteps) fields['Next Steps'] = body.nextSteps;
    if (body.nextStepDue) fields['Next Step Due?'] = body.nextStepDue;
    if (body.performedBy) fields['Performed By'] = [body.performedBy];

    const data = await atPost(env, 'Activity Log', fields);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    return new Response(JSON.stringify({ id: data.id, ok: true }), {
      status: 200, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── POST /api/statement ───────────────────────────────────────────────────────
// Body: { client: string, date?: string }
// Returns: PDF bytes

async function handleApiStatement(request, env) {
  try {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: apiCorsHeaders }); }

    const clientName = body.client;
    if (!clientName) return new Response(JSON.stringify({ error: 'client required' }), {
      status: 400, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });

    // Fetch invoices for this client
    const cf = encodeURIComponent(`{Client Name}="${clientName}"`);
    const cdata = await atFetch(env, `Clients?filterByFormula=${cf}&fields[]=Client+Name`);
    const clientRec = (cdata.records || [])[0];
    if (!clientRec) return new Response(JSON.stringify({ error: 'Client not found' }), {
      status: 404, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });

    const clientId = clientRec.id;
    const sf = encodeURIComponent(`AND(OR({Status}="Unpaid",{Status}="Partially Paid"),FIND("${clientId}",ARRAYJOIN({Client})))`);
    const invoices = await atFetchAll(env, 'Invoices',
      `filterByFormula=${sf}&fields[]=Invoice+Number&fields[]=Balance+Due&fields[]=Due+Date&fields[]=Days+Overdue&fields[]=Projects`);

    const projectIds = new Set();
    invoices.forEach(r => (r.fields['Projects'] || []).forEach(id => projectIds.add(id)));
    const projectNames = {};
    const pidArr = [...projectIds];
    for (let i = 0; i < pidArr.length; i += 100) {
      const batch = pidArr.slice(i, i + 100);
      const f = encodeURIComponent(`OR(${batch.map(id => `RECORD_ID()="${id}"`).join(',')})`);
      const data = await atFetch(env, `Projects?filterByFormula=${f}&fields[]=Project+Name&fields[]=Project+Code`);
      (data.records || []).forEach(r => { projectNames[r.id] = r.fields['Project Name'] || r.fields['Project Code'] || r.id; });
    }

    // Fetch activity log notes for these invoice record IDs
    const invIdToNum = {};
    invoices.forEach(r => { invIdToNum[r.id] = String(r.fields['Invoice Number'] || '').trim(); });
    const activityByInv = {};
    const clientFacingActions = ['Note Added', 'Email Received', 'Phone Call'];
    const actionFilter = encodeURIComponent(`OR(${clientFacingActions.map(a => `{Action Taken}="${a}"`).join(',')})`);
    const actRecords = await atFetchAll(env, 'Activity Log',
      `filterByFormula=${actionFilter}&fields[]=Invoices&fields[]=Date&fields[]=Notes&fields[]=Client+Contact&sort[0][field]=Date&sort[0][direction]=desc`);

    actRecords.forEach(r => {
      const linkedInvIds = r.fields['Invoices'] || [];
      const date = r.fields['Date'] || '';
      const note = String(r.fields['Notes'] || '').trim();
      const contactRaw = r.fields['Client Contact'];
      const contactName = typeof contactRaw === 'string'
        ? contactRaw.replace(/\s*\(.*?\)\s*/g, '').trim()
        : '';
      const by = contactName ? ` --${contactName}` : '';
      if (!note || note.startsWith('Triage:') || note.startsWith('Action assigned:')) return;
      linkedInvIds.forEach(id => {
        const invNum = invIdToNum[id];
        if (!invNum) return;
        if (!activityByInv[invNum]) activityByInv[invNum] = [];
        activityByInv[invNum].push(`${date}: ${note}${by}`);
      });
    });

    // Build invoice data
    const today = new Date();
    const invData = invoices.map(r => {
      const f = r.fields;
      const invNum = String(f['Invoice Number'] || '').trim();
      const balance = parseFloat(f['Balance Due'] || 0);
      if (!invNum || balance <= 0) return null;
      const due = f['Due Date'] || '';
      let daysOverdue = parseInt(f['Days Overdue'] || 0);
      if (due && !daysOverdue) daysOverdue = Math.max(0, Math.floor((today - new Date(due)) / 86400000));
      const projIds = f['Projects'] || [];
      const project = projIds.length ? (projectNames[projIds[0]] || projIds[0]) : invNum.split('-').slice(0, -1).join('-') || invNum;
      const notes = (activityByInv[invNum] || []).join('\n');
      return { invNum, balance, due, daysOverdue, project, notes };
    }).filter(Boolean);

    const total = invData.reduce((s, i) => s + i.balance, 0);
    const stmtDate = body.date || today.toISOString().split('T')[0];
    const dateFormatted = new Date(stmtDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const html = buildStatementHTML(clientName, total, invData, dateFormatted);

    // Call PDFShift
    const pdfRes = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: { 'X-API-Key': env.PDFSHIFT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: html, landscape: false, use_print: false, format: 'Letter' }),
    });
    if (!pdfRes.ok) {
      const err = await pdfRes.text();
      return new Response(err, { status: pdfRes.status, headers: { ...apiCorsHeaders, 'Content-Type': 'text/plain' } });
    }
    const pdf = await pdfRes.arrayBuffer();
    return new Response(pdf, { status: 200, headers: { ...apiCorsHeaders, 'Content-Type': 'application/pdf' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...apiCorsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── Statement HTML builder ────────────────────────────────────────────────────

function formatNotes(notes) {
  if (!notes) return '';
  const entries = notes.split(/\n(?=\d{4}-\d{2}-\d{2}:)/).map(l => l.trim()).filter(l => l);
  function renderEntry(entry) {
    const nameMatch = entry.match(/\s--([^-\n]+)$/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    const text = nameMatch ? entry.slice(0, -nameMatch[0].length).trim() : entry;
    const cleaned = text.replace(/\n/g, ' ');
    return `<div style="line-height:1.6">${cleaned}${name ? `<span style="font-size:9px;color:#aaa;margin-left:6px">— ${name}</span>` : ''}</div>`;
  }
  if (entries.length <= 1) return renderEntry(notes.trim());
  return entries.map((entry, i) => {
    const isLast = i === entries.length - 1;
    return `<div style="${isLast ? '' : 'margin-bottom:5px;padding-bottom:5px;border-bottom:1px dotted #e0e0e0;'}">${renderEntry(entry)}</div>`;
  }).join('');
}

function buildStatementHTML(clientName, total, invoices, dateFormatted) {
  const fmt = n => '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const byProject = {};
  invoices.forEach(inv => {
    if (!byProject[inv.project]) byProject[inv.project] = [];
    byProject[inv.project].push(inv);
  });

  const projectEntries = Object.entries(byProject);
  const multipleProjects = projectEntries.length > 1;
  let invoiceRows = '';

  projectEntries.forEach(([project, invs]) => {
    invoiceRows += `<tr><td colspan="4" style="background:#f5f5f5;padding:8px 12px;font-weight:600;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.05em;border-top:2px solid #ddd">${project}</td></tr>`;
    const projTotal = invs.reduce((s, i) => s + i.balance, 0);
    const mostRecentNote = inv => (inv.notes || '').split(/\n(?=\d{4}-\d{2}-\d{2}:)/)[0].trim() || '';
    const firstNote = mostRecentNote(invs[0]);
    const allSameNote = invs.length > 1 && firstNote && invs.every(inv => mostRecentNote(inv) === firstNote);

    invs.forEach((inv, idx) => {
      const dueStr = inv.due ? new Date(inv.due).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '—';
      const overdueColor = inv.daysOverdue > 90 ? '#c0392b' : inv.daysOverdue > 60 ? '#e67e22' : inv.daysOverdue > 30 ? '#f39c12' : '#666';
      const overdueLabel = inv.daysOverdue > 0
        ? `<div style="font-size:10px;color:${overdueColor};font-weight:500;margin-top:2px">${inv.daysOverdue} days past due</div>`
        : `<div style="font-size:10px;color:#27ae60;margin-top:2px">Current</div>`;
      const showNotes = allSameNote
        ? (idx === 0 ? formatNotes(firstNote) : '<span style="font-size:9px;color:#ccc;font-style:italic">↑ see above</span>')
        : formatNotes(inv.notes);
      invoiceRows += `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 12px;font-size:12px;font-family:monospace">${inv.invNum}</td>
          <td style="padding:10px 12px;font-size:12px">
            <div style="color:#333">${dueStr}</div>
            ${overdueLabel}
          </td>
          <td style="padding:10px 12px;font-size:12px;text-align:right;font-weight:500;color:#8B0000">${fmt(inv.balance)}</td>
          <td style="padding:10px 12px;font-size:11px;color:#666;max-width:240px">${showNotes}</td>
        </tr>`;
    });

    if (multipleProjects) {
      invoiceRows += `
        <tr style="background:#faf0f0;border-top:1px solid #e0c0c0;border-bottom:2px solid #ddd">
          <td colspan="2" style="padding:8px 12px;font-size:11px;font-weight:600;color:#8B0000;text-transform:uppercase;letter-spacing:0.04em">Project Subtotal</td>
          <td style="padding:8px 12px;font-size:12px;text-align:right;font-weight:700;color:#8B0000">${fmt(projTotal)}</td>
          <td></td>
        </tr>`;
    }
  });

  return `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f0f0f0">
    <div style="background:white;font-family:'Helvetica Neue',Arial,sans-serif;max-width:900px;margin:0 auto;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden">
      <div style="padding:20px 40px 16px 40px;border-bottom:3px solid #8B0000;display:flex;justify-content:space-between;align-items:flex-start">
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:8px">
          <img src="${LOGO_URL}" style="height:80px;display:block;flex-shrink:0" />
          <div>
            <div style="font-size:9px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">MEP Engineers</div>
            <div style="font-size:11px;color:#555;line-height:1.7;white-space:nowrap">4241 S River Rd. Ste. B, St. George, UT 84790</div>
            <div style="font-size:11px;color:#555;white-space:nowrap">(435) 253-7200 &nbsp;&middot;&nbsp; accounting@shakespeare-eng.com</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:24px;font-weight:800;color:#8B0000;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">Account Statement</div>
          <div style="font-size:11px;color:#666;line-height:1.9">
            <span style="color:#333;font-weight:600">Date:</span> ${dateFormatted} &nbsp;|&nbsp; <span style="color:#333;font-weight:600">Client:</span> ${clientName}
          </div>
          <div style="margin-top:8px;display:inline-block;padding:8px 18px;background:#8B0000;border-radius:3px;text-align:center">
            <div style="font-size:9px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.1em">Total Outstanding</div>
            <div style="font-size:22px;font-weight:800;color:white;line-height:1.2">${fmt(total)}</div>
          </div>
        </div>
      </div>
      <div style="padding:12px 40px;background:#fafafa;border-bottom:1px solid #eee;font-size:11px;color:#666;line-height:1.5">
        Please review the outstanding invoices below. <strong>A response is kindly requested if:</strong>
        <ul style="margin:6px 0 2px 0;padding-left:20px;line-height:1.8">
          <li>An invoice does <strong>not</strong> have a note in the Notes column, <strong>or</strong></li>
          <li>The most recent note on an invoice is <strong>3+ months old</strong></li>
        </ul>
        <span style="color:#777">If neither applies, no action is required — this statement is for your information only. Questions? Contact us at <strong>accounting@shakespeare-eng.com</strong>.</span>
      </div>
      <div style="padding:0 0 24px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#8B0000;color:white">
              <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em">INVOICE #</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em">DUE DATE</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.05em">BALANCE DUE</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em">NOTES</th>
            </tr>
          </thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </div>
    </div>
  </body></html>`;
}

// ── Existing proxy routes ─────────────────────────────────────────────────────

async function handlePdf(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400, headers: corsHeaders }); }

  const upstream = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: { 'X-API-Key': env.PDFSHIFT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, { status: upstream.status, headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
  }
  const pdf = await upstream.arrayBuffer();
  return new Response(pdf, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/pdf' } });
}

async function handleToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400, headers: corsHeaders }); }

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
