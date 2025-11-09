// Vercel serverless function: POST /api/send-devis
// Pas de types @vercel/node pour éviter TS2307
import nodemailer from "nodemailer";

// Origins autorisés (prod + local dev Astro)
const ALLOWED_ORIGINS = [
  "https://www.expertisediag.fr",
  "http://localhost:4321",
];

// Limites simples de longueur (sanitization)
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

export default async function handler(req: any, res: any) {
  // CORS basique
  const origin = String(req.headers?.origin || "");
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const b = (req.body || {}) as Record<string, string>;

    // Honeypot anti-bot (champ caché côté front)
    if ((b.company || "").trim()) return res.status(200).json({ ok: true });

    // hCaptcha côté serveur
    const token = (b.hcaptchaToken || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "captcha_missing" });

    const secret = process.env.HCAPTCHA_SECRET;
    if (!secret) throw new Error("HCAPTCHA_SECRET missing");

    const vresp = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    const vjson = await vresp.json();
    if (!vjson?.success) return res.status(400).json({ ok: false, error: "captcha_failed" });

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
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) {
      return res.status(400).json({ ok: false, error: "invalid_email" });
    }
    if (!/^[0-9+().\s-]{6,}$/.test(v.phone)) {
      return res.status(400).json({ ok: false, error: "invalid_phone" });
    }

    // ===== Envoi email via OVH SMTP (Nodemailer) =====
    const host = process.env.SMTP_HOST || "";
    const port = Number(process.env.SMTP_PORT || "587"); // 587 STARTTLS par défaut
    const user = process.env.SMTP_USER || "";
    const pass = process.env.SMTP_PASS || "";
    const MAIL_TO = process.env.MAIL_TO || "contact@expertisediag.fr";

    const canEmail = !!host && !!user && !!pass;
    if (!canEmail) {
      // SMTP non configuré -> on répond explicitement
      return res.status(501).json({ ok: false, error: "email_disabled" });
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true si 465 (SMTPS), sinon STARTTLS
      auth: { user, pass },
    });

    const subject = `Demande de devis — ${v.fullName} (${v.context || "—"})`;
    const html = buildHtml(v);
    const text = buildPlainText(v);

    await transporter.sendMail({
      from: `"Expertise Diag" <${user}>`, // expéditeur = ta boîte OVH
      to: MAIL_TO,
      replyTo: v.email ? v.email : undefined, // si l’utilisateur a mis un email
      subject,
      text,
      html,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "internal" });
  }
}

// -------- Utils --------
function txt(s: any) { return typeof s === "string" ? s.trim() : ""; }
function cut(s: string, n: number) { return s.length > n ? s.slice(0, n) : s; }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => (
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[m]!
  ));
}

function buildPlainText(v: Record<string,string>) {
  const lines = [
    "Demande de devis — Expertise Diag",
    "",
    "Nom: " + v.fullName,
    "Téléphone: " + v.phone,
    "Email: " + (v.email || "—"),
    "Ville: " + (v.city || "—"),
    "Type de bien: " + (v.propertyType || "—"),
    "Contexte: " + (v.context || "—"),
    "Diagnostics: " + (v.diagnostics || "—"),
    "",
    "Message:",
    v.message,
  ];
  return lines.join("\n");
}

function buildHtml(v: Record<string,string>) {
  return (
    "<h2>Demande de devis</h2>" +
    "<ul>" +
    "<li><b>Nom</b> : " + esc(v.fullName) + "</li>" +
    "<li><b>Téléphone</b> : " + esc(v.phone) + "</li>" +
    "<li><b>Email</b> : " + esc(v.email || "—") + "</li>" +
    "<li><b>Ville</b> : " + esc(v.city || "—") + "</li>" +
    "<li><b>Type de bien</b> : " + esc(v.propertyType || "—") + "</li>" +
    "<li><b>Contexte</b> : " + esc(v.context || "—") + "</li>" +
    "<li><b>Diagnostics</b> : " + esc(v.diagnostics || "—") + "</li>" +
    "</ul>" +
    "<p><b>Message :</b><br/>" + esc(v.message).replace(/\n/g, "<br/>") + "</p>"
  );
}
