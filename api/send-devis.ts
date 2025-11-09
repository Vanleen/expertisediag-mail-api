// api/send-devis.ts
import type { IncomingMessage, ServerResponse } from 'http';
import nodemailer from 'nodemailer';

// --- ORIGINES AUTORISÉES (dev + prod) ---
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:4321',
  'http://localhost:4321',
  'https://expertisediag.fr',
  'https://www.expertisediag.fr',
]);

// Limites simples
const MAX = {
  fullName: 120,
  phone: 40,
  email: 120,
  city: 120,
  propertyType: 60,
  context: 60,
  diagnostics: 400,
  message: 4000,
};

// Utils
function txt(v: any) { return typeof v === 'string' ? v.trim() : ''; }
function cut(s: string, n: number) { return s.length > n ? s.slice(0, n) : s; }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string,string>)[m]!
  ));
}
async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

// --- HANDLER ---
export default async function handler(req: any, res: any) {
  // CORS
  const origin = String(req?.headers?.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
  }

  try {
    const body = await readJson(req);

    // Honeypot
    if (txt(body.company)) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    // hCaptcha server-side
    const token = txt(body.hcaptchaToken);
    const secret = process.env.HCAPTCHA_SECRET;
    if (!secret) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'server_config' }));
    }
    if (!token) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'captcha_missing' }));
    }

    const verify = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    }).then(r => r.json());

    if (!verify?.success) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'captcha_failed' }));
    }

    // Données + validations
    const v = {
      fullName: cut(txt(body.fullName), MAX.fullName),
      phone: cut(txt(body.phone), MAX.phone),
      email: cut(txt(body.email), MAX.email),
      city: cut(txt(body.city), MAX.city),
      propertyType: cut(txt(body.propertyType), MAX.propertyType),
      context: cut(txt(body.context), MAX.context),
      diagnostics: cut(Array.isArray(body.diagnostics) ? body.diagnostics.join(', ') : txt(body.diagnostics), MAX.diagnostics),
      message: cut(txt(body.message), MAX.message),
    };

    if (!v.fullName || !v.phone || !v.message) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'missing_fields' }));
    }
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_email' }));
    }
    if (!/[0-9()+.\- ]{6,}/.test(v.phone)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_phone' }));
    }

    // SMTP (OVH)
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const TO_EMAIL  = process.env.MAIL_TO || process.env.TO_EMAIL || 'contact@expertisediag.fr';

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'smtp_config' }));
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const subject = `Demande de devis — ${v.fullName} (${v.context || '—'})`;
    const html = `
      <h2>Demande de devis</h2>
      <ul>
        <li><b>Nom</b> : ${esc(v.fullName)}</li>
        <li><b>Téléphone</b> : ${esc(v.phone)}</li>
        <li><b>Email</b> : ${esc(v.email || '—')}</li>
        <li><b>Ville</b> : ${esc(v.city || '—')}</li>
        <li><b>Type de bien</b> : ${esc(v.propertyType || '—')}</li>
        <li><b>Contexte</b> : ${esc(v.context || '—')}</li>
        <li><b>Diagnostics</b> : ${esc(v.diagnostics || '—')}</li>
      </ul>
      <p><b>Message :</b><br/>${esc(v.message).replace(/\n/g, '<br/>')}</p>
    `;
    const text = html.replace(/<[^>]+>/g, '');

    await transporter.sendMail({
      from: `"Expertise Diag" <${SMTP_USER}>`,
      to: TO_EMAIL,
      subject,
      text,
      html,
      replyTo: v.email || undefined,
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    console.error('send-devis error:', e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'internal' }));
  }
}
