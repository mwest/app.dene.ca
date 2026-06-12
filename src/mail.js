// Outbound email via Resend (https://resend.com) — plain fetch, no SDK needed.
// Degrades gracefully: if RESEND_API_KEY is not set, sendMail() reports
// {sent:false} and callers fall back to showing the action link to the admin.

const FROM = process.env.MAIL_FROM || 'Dene Voice Library <noreply@app.dene.ca>';
export const APP_URL = (process.env.APP_URL || 'https://app.dene.ca').replace(/\/$/, '');

export const mailEnabled = () => !!process.env.RESEND_API_KEY;

export async function sendMail({ to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[mail] RESEND_API_KEY not set — not sending "${subject}" to ${to}`);
    return { sent: false, reason: 'mail not configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, text, html }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`[mail] Resend ${r.status} sending "${subject}" to ${to}: ${detail}`);
      return { sent: false, reason: `Resend error ${r.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[mail] network error sending to ${to}:`, err);
    return { sent: false, reason: 'network error' };
  }
}

const wrap = (body) => `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#222">
    <h2 style="color:#1f4e5f">🪶 Dene Voice Library</h2>
    ${body}
    <p style="color:#888;font-size:12px;margin-top:24px">
      Dene Voice Project · dene.ca — if you weren’t expecting this email you can ignore it.</p>
  </div>`;

export function inviteEmail({ name, link, invitedBy, projectName }) {
  const intro = projectName
    ? `${invitedBy} added you to the <b>${projectName}</b> project on the Dene Voice Library.`
    : `${invitedBy} created an account for you on the Dene Voice Library.`;
  return {
    subject: 'Your Dene Voice Library account',
    text: `Hi ${name},\n\n${intro.replace(/<[^>]+>/g, '')}\n\nSet your password to get started (link valid for 7 days):\n${link}\n`,
    html: wrap(`<p>Hi ${name},</p><p>${intro}</p>
      <p><a href="${link}" style="background:#1f4e5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Set your password</a></p>
      <p style="color:#666;font-size:13px">This link is valid for 7 days. Or paste this URL into your browser:<br>${link}</p>`),
  };
}

export function resetEmail({ name, link }) {
  return {
    subject: 'Reset your Dene Voice Library password',
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset your password.\n\nReset it here (link valid for 2 hours):\n${link}\n\nIf this wasn’t you, you can ignore this email.\n`,
    html: wrap(`<p>Hi ${name},</p><p>Someone (hopefully you) asked to reset your password.</p>
      <p><a href="${link}" style="background:#1f4e5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
      <p style="color:#666;font-size:13px">This link is valid for 2 hours. If this wasn’t you, ignore this email.</p>`),
  };
}
