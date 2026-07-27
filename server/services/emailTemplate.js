/**
 * ARCHON: HTML wrapper for transactional email (activation, password reset).
 *
 * The site's only two emails were bare plain text with no identity at all,
 * which for a password reset is exactly the kind of message people are trained
 * to distrust. This wraps the same copy in a small branded layout and keeps the
 * plain-text version alongside it, so clients that refuse HTML — and anyone who
 * prefers it — still get a readable message.
 *
 * Deliberately hand-written table-free HTML with inline styles: mail clients
 * strip <style> blocks and ignore most modern CSS, so anything fancier would
 * degrade unpredictably. No images, so nothing breaks when a client blocks
 * remote content and nothing leaks an open-tracking signal.
 */

// Brand amber, matching --brand in client/styles/tailwind.css.
const BRAND = '#efc54a';
const INK = '#1c2030';
const MUTED = '#5b6172';

const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
    );

/**
 * Wrap body content in the site layout.
 *
 * @param {object} options
 * @param {string} options.appName    site name, shown as the header
 * @param {string} options.title      headline inside the card
 * @param {string[]} options.paragraphs  body copy (plain text; escaped)
 * @param {{ label: string, url: string }} [options.action] call-to-action button
 * @param {string} [options.footer]   small print under the card
 * @returns {string} HTML
 */
function renderHtmlEmail({ appName, title, paragraphs = [], action, footer }) {
    const body = paragraphs
        .map(
            (text) =>
                `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(
                    text
                )}</p>`
        )
        .join('');

    const button = action
        ? `<p style="margin:24px 0;">
             <a href="${escapeHtml(action.url)}"
                style="display:inline-block;padding:12px 22px;background:${BRAND};color:${INK};
                       font-weight:bold;font-size:15px;text-decoration:none;border-radius:6px;">
               ${escapeHtml(action.label)}
             </a>
           </p>
           <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED};">
             If the button does not work, copy this link into your browser:<br />
             <span style="word-break:break-all;">${escapeHtml(action.url)}</span>
           </p>`
        : '';

    return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px 12px;background:#f4f5f7;
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="padding:0 4px 12px;font-size:18px;font-weight:bold;letter-spacing:0.02em;color:${INK};">
        ${escapeHtml(appName)}
      </div>
      <div style="background:#ffffff;border:1px solid #e3e5ea;border-top:3px solid ${BRAND};
                  border-radius:8px;padding:24px;">
        <h1 style="margin:0 0 16px;font-size:19px;line-height:1.3;color:${INK};">${escapeHtml(
        title
    )}</h1>
        ${body}
        ${button}
      </div>
      <div style="padding:14px 4px;font-size:12px;line-height:1.6;color:${MUTED};">
        ${escapeHtml(footer || '')}
      </div>
    </div>
  </body>
</html>`;
}

/**
 * The same message as plain text, for the multipart alternative.
 *
 * @returns {string}
 */
function renderTextEmail({ appName, title, paragraphs = [], action, footer }) {
    const parts = [title, '', ...paragraphs];

    if (action) {
        parts.push('', `${action.label}: ${action.url}`);
    }

    if (footer) {
        parts.push('', footer);
    }

    parts.push('', `— ${appName}`);

    return parts.join('\n');
}

module.exports = { renderHtmlEmail, renderTextEmail, escapeHtml };
