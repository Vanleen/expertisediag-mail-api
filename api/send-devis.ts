// Vercel serverless function: POST /api/send-devis
// NOTE: pas d'import de types @vercel/node -> évite l'erreur TS2307
import * as Brevo from '@getbrevo/brevo';

// Origins autorisés (prod + local dev Astro)
const ALLOWED_ORIGINS = [
  'https://www.expertisediag.fr',
  'http://localhost:4321',
];

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

// Handler compatible Vercel (sans typings externes)
export default async function handler(req: any, res: any) {
  // CORS basique
  const origin = String(req.headers?.origin || '');
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    const b = (req.body || {}) as Record<string, string>;

    // Honeypot anti-bot (champ caché côté front)
    if ((b.company || '').trim()) return res.status(200).json({ ok: true });

    // hCaptcha côté serveur
    const token = (b.hcaptchaToken || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'captcha_missing' });

    const secret = process.env.HCAPTCHA_SECRET;
    if (!secret) throw new Error('HCAPTCHA_SECRET missing');

    const vresp = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const vjson = await vresp.json();
    if (!vjson?.success) return res.status(400).json({ ok: false, error: 'captcha_failed' });

    // Sanitize + validations
    const v = {
      fullName: cut(txt(b.fullName), MAX.fullName),
      phone: cut(txt(b.phone), MAX.phone),
      email: cut(txt(b.email), MAX.email),
      city: cut(txt(b.city), MAX.city),
      propertyType: cut(txt(b.propertyType), MAX.propertyType),
      context: cut(txt(b.context), MAX.context),
      diagnostics: cut(txt(b.diagnostics), MAX.diagnostics),
      message: cut(txt(b.message), MAX.message),
    };

    if (!v.fullName || !v.phone || !v.message) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!/^[0-9+().\s-]{6,}$/.test(v.phone)) {
      return res.status(400).json({ ok: false, error: 'invalid_phone' });
    }

    // Envoi email via Brevo
    const apiKey = process.env.BREVO_API_KEY;
    const fromEmail = process.env.FROM_EMAIL || 'no-reply@expertisediag.fr';
    const toEmail = process.env.TO_EMAIL || 'contact@expertisediag.fr';
    if (!apiKey) throw new Error('BREVO_API_KEY missing');

    const client = new (Brevo as any).TransactionalEmailsApi();
    client.setApiKey((Brevo as any).TransactionalEmailsApiApiKeys.apiKey, apiKey);

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

    await client.sendTransacEmail({
      sender: { email: fromEmail, name: 'Expertise Diag' },
      to: [{ email: toEmail }],
      subject,
      htmlContent: html,
      textContent: text,
      replyTo: v.email ? { email: v.email } : undefined,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

function txt(s: any) { return typeof s === 'string' ? s.trim() : ''; }
function cut(s: string, n: number) { return s.length > n ? s.slice(0, n) : s; }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[m]!
  ));
}
