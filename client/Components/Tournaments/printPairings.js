/**
 * ARCHON: printable pairings/standings slip for IRL events - opens a
 * minimal print window (no app chrome) and invokes the print dialog.
 */
const escapeHtml = (value) =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
    );

/** Tiebreakers to one decimal - they separate players by fractions. */
const percent = (rate) => `${((rate || 0) * 100).toFixed(1)}%`;

export default function printPairings(tournament, matches, round, standings) {
    const printWindow = window.open('', '_blank', 'width=800,height=900');

    if (!printWindow) {
        return;
    }

    const rows = matches
        .map((match) => {
            const table = match.table ? `Table ${match.table}` : '';
            const players = match.player2
                ? `${escapeHtml(match.player1)} vs ${escapeHtml(match.player2)}`
                : `${escapeHtml(match.player1)} — BYE`;
            const score =
                match.player1Wins + match.player2Wins > 0
                    ? `${match.player1Wins}-${match.player2Wins}`
                    : '';

            return `<tr><td>${table}</td><td>${players}</td><td>${score}</td><td class="line"></td></tr>`;
        })
        .join('');

    const standingRows = (standings || [])
        .map(
            (entry) =>
                `<tr><td>${entry.rank}</td><td>${escapeHtml(entry.username)}</td>` +
                `<td>${entry.wins}-${entry.losses}</td><td>${entry.points}</td>` +
                `<td>${percent(entry.opponentMatchWinRate)}</td>` +
                `<td>${percent(entry.gameWinRate)}</td></tr>`
        )
        .join('');

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<title>${escapeHtml(tournament.name)} — Round ${round}</title>
<style>
    body { font-family: Georgia, serif; margin: 2rem; color: #111; }
    h1 { font-size: 1.3rem; margin: 0 0 0.25rem; }
    h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
    .meta { color: #555; font-size: 0.85rem; margin-bottom: 1rem; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border-bottom: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.95rem; }
    td.line { width: 30%; }
</style>
</head>
<body>
<h1>${escapeHtml(tournament.name)}</h1>
<div class="meta">Round ${round} pairings — result signature line at right</div>
<table><tbody>${rows}</tbody></table>
${
    standingRows
        ? `<h2>Standings</h2><table><thead><tr><th>#</th><th>Player</th><th>Record</th><th>Points</th><th>OMW%</th><th>GW%</th></tr></thead><tbody>${standingRows}</tbody></table>`
        : ''
}
<script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
    printWindow.document.close();
}
