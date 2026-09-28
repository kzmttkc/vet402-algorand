/** Human-facing root page and favicon (the leaderboard and browsers read the site title and icon). */
/** The official vet402 icon on a white plate (512 px PNG), for link rel=icon and og:image. */
export const ICON_PNG_B64 = "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";
export const FAVICON_ICO_B64 = "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";

export const REPO_URL = "https://github.com/kzmttkc/vet402-algorand";

/** Colors and base type shared with /board (same dark look on every human page). */
export const BASE_CSS = `:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.09);--card:#111827;--card2:#0f1626;--acc:#60a5fa;--link:#93c5fd;--delivered:#34d399;--mismatch:#f87171;--unreach:#9ca3af;--unclear:#f59e0b}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
a{color:var(--link)}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px}
.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;max-width:960px;margin:0 auto;padding:14px 16px;font-size:14px}
.top .brand{color:var(--fg);font-weight:700;text-decoration:none;letter-spacing:.01em}
.top nav{display:flex;gap:14px;flex-wrap:wrap}
.top nav a{color:var(--mut);text-decoration:none}
.top nav a:hover{color:var(--fg)}
.btn{display:inline-block;padding:10px 18px;border-radius:10px;background:var(--acc);color:#06101f;font-weight:650;text-decoration:none;border:0;font-size:16px;cursor:pointer}
.btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.delivered{color:var(--delivered)} .mismatch{color:var(--mismatch)} .unreach{color:var(--unreach)} .unclear{color:var(--unclear)}
footer{max-width:960px;margin:0 auto;padding:24px 16px 40px;color:var(--mut);font-size:13px}`;

export function topNav(): string {
  return `<header class="top"><a class="brand" href="/">vet402</a><nav><a href="/try">Try</a><a href="/board">Board</a><a href="/activity">Activity</a><a href="/fairness">Fairness</a><a href="/demo">Demo</a><a href="${REPO_URL}" rel="noopener">GitHub</a></nav></header>`;
}

/**
 * The first census (2026-09-27, kept as it was recorded): the numbers in the "what vet402 found" block.
 * Fixed on purpose: the sentence is dated, so it stays true on the day it is read.
 */
export const FIRST_CENSUS = { date: "2026-09-27", dateLabel: "27 September 2026", listed: 1819, sellers: 112, paid: 575, paidUsdc: "16.05", delivered: 495, mismatch: 80, unreachable: 422, unclear: 822 };

export interface LandingOptions {
  network: string;
  priceUsdc: string;
  perCallUsdc: string;
  perDayUsdc: string;
  /** /v1/buy fee, USDC. */
  buyFeeUsdc?: string;
  verdictPriceUsdc?: string;
  auditPriceUsdc?: string;
  /** Free trials are open (/try/run). Off: step 3 points to buying through /v1/buy instead. */
  trial?: boolean;
  /** ?from= tag of this visit (already validated), carried to the /try links. */
  from?: string;
}

const short = (usdc: string) => usdc.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const n = (x: number) => x.toLocaleString("en-US");

export function landingHtml(o: LandingOptions): string {
  const fee = short(o.buyFeeUsdc ?? "0.005");
  const c = FIRST_CENSUS;
  const tryHref = o.from ? `/try?from=${encodeURIComponent(o.from)}` : "/try";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402</title>
<meta name="description" content="vet402 pays the x402 endpoint you name on Algorand, checks the delivery against what the seller declared, and returns ALLOW or REFUSE with both payment tx ids.">
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/icon-512.png">
<meta property="og:site_name" content="vet402">
<meta property="og:title" content="vet402 — pays the x402 endpoint you name and checks the delivery">
<meta property="og:description" content="vet402 pays the x402 endpoint you name on Algorand, checks the delivery against what the seller declared, and returns ALLOW or REFUSE with both payment tx ids.">
<meta property="og:image" content="https://vet402-algorand.vercel.app/icon-512.png">
<style>
${BASE_CSS}
main{max-width:960px;margin:0 auto;padding:0 16px}
section{padding:36px 0;border-top:1px solid var(--line)}
section.hero{border-top:0;padding:28px 0 40px}
h1{font-size:clamp(26px,5.2vw,42px);line-height:1.18;margin:0 0 16px;letter-spacing:-.01em;max-width:22em}
h2{font-size:22px;margin:0 0 6px}
.kicker{color:var(--mut);margin:0 0 18px;font-size:15px}
.lead{font-size:18px;color:#cbd5e1;max-width:40em;margin:0 0 22px}
.ctas{display:flex;gap:10px;flex-wrap:wrap}
ol.steps{list-style:none;padding:0;margin:18px 0 20px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
ol.steps li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
ol.steps b{display:block;font-size:17px;margin:6px 0 4px}
ol.steps .num{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:rgba(96,165,250,.16);color:var(--acc);font-weight:700;font-size:14px}
ol.steps p{margin:0;color:var(--mut);font-size:15px}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:18px 0 12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:34px;line-height:1.1;font-variant-numeric:tabular-nums}
.stat span{color:#cbd5e1;font-size:15px}
.note{color:var(--mut);font-size:14px;max-width:44em}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:12px;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
tr:last-child td{border-bottom:0}
th{color:var(--mut);font-weight:600;white-space:nowrap}
td:first-child{white-space:nowrap}
@media (max-width:560px){table,thead,tbody,tr,th,td{display:block}thead{display:none}tr{border-bottom:1px solid var(--line);padding:8px 0}td{border:0;padding:3px 12px}td:first-child{white-space:normal}}
.links{display:flex;gap:16px;flex-wrap:wrap;font-size:15px}
</style>
</head><body>
${topNav()}
<main>
<section class="hero">
<h1>Before your AI agent pays for an API, vet402 buys it with its own wallet and tells you if it actually delivered.</h1>
<p class="lead">Paid APIs for agents take the money first and answer second. The listing says what you will get, and nobody checks. vet402 pays, compares what came back with what was promised, and leaves the payment receipt on the blockchain where anyone can look it up.</p>
<div class="ctas"><a class="btn" href="${tryHref}">Try it free</a><a class="btn ghost" href="/board?view=census">See every result</a></div>
</section>

<section id="try">
<h2>Try it in 3 steps</h2>
<p class="kicker">${o.trial ? "No account and no wallet. All three steps are free (step 3 once per person)." : "No account. The first two steps cost nothing."}</p>
<ol class="steps">
<li><span class="num">1</span><b>Pick a seller</b><p>Choose one from <a href="/board?view=census">the board</a>, or paste the URL of any paid API on Algorand.</p></li>
<li><span class="num">2</span><b>See what vet402 got last time</b><p>Free. What it paid, whether the answer matched the listing, and the receipt.</p></li>
${
  o.trial
    ? `<li><span class="num">3</span><b>Watch vet402 buy it now</b><p>Free, once per person: vet402 pays the seller from its own wallet and shows you what came back.</p></li>`
    : `<li><span class="num">3</span><b>Buy it through vet402</b><p>The seller's price + ${fee} USDC. You get the seller's answer, checked, with both receipts.</p></li>`
}
</ol>
<a class="btn" href="${tryHref}">Start at step 1</a>
</section>

<section id="found">
<h2>What happened when vet402 bought everything</h2>
<p class="kicker">On ${c.dateLabel}, vet402 went through all ${n(c.listed)} resources listed for Algorand in the x402 Bazaar, from ${n(c.sellers)} sellers. It paid ${n(c.paid)} of them from its own wallet, ${c.paidUsdc} USDC in total.</p>
<div class="stats">
<div class="stat"><b class="delivered">${n(c.delivered)}</b><span>delivered what the listing promised</span></div>
<div class="stat"><b class="mismatch">${n(c.mismatch)}</b><span>took the payment and sent back something else</span></div>
<div class="stat"><b class="unreach">${n(c.unreachable)}</b><span>were listed but did not even ask for payment (dead page or host)</span></div>
</div>
<p class="note">Another ${n(c.unclear)} ended without a clear answer (rate limits, payments that did not go through, vet402's own price limit). Those are not held against the seller. Every row, with its receipt: <a href="/board?view=census&amp;date=${c.date}">census of ${c.date}</a>.</p>
</section>

<section id="developers">
<h2>For developers</h2>
<p class="kicker">x402 over HTTP on Algorand (<code>${o.network}</code>), paid in USDC. An unpaid request is free and returns the 402 with the price.</p>
<div class="tw"><table>
<thead><tr><th>Endpoint</th><th>Price (USDC)</th><th>What you get</th></tr></thead>
<tbody>
<tr><td><code>GET /v1/check?url=</code></td><td>${short(o.priceUsdc)}</td><td>vet402 pays the seller once and answers ALLOW or REFUSE, with your tx and its tx to the seller.</td></tr>
<tr><td><code>GET|POST /v1/buy?url=</code></td><td>seller's price + ${fee}</td><td>The seller's response as-is, bought and checked by vet402. Verdict and both tx ids in <code>x-vet402-*</code> headers. No refunds.</td></tr>
<tr><td><code>GET /v1/verdict?url=</code></td><td>${short(o.verdictPriceUsdc ?? "0.001")}</td><td>vet402's last recorded result for that URL. Pays no seller.</td></tr>
<tr><td><code>GET /v1/audit?seller=</code></td><td>${short(o.auditPriceUsdc ?? "0.50")}</td><td>The same check for each resource the seller lists in the Bazaar. The unpaid request shows the plan.</td></tr>
<tr><td>MCP server</td><td>free to install</td><td><code>vet402_check</code> for Claude and other agents. See <a href="${REPO_URL}/tree/main/mcp" rel="noopener">mcp/</a>.</td></tr>
</tbody></table></div>
<p class="note">Your payment settles first; the seller is paid only after that. vet402 pays at most ${short(o.perCallUsdc)} USDC per seller call and ${short(o.perDayUsdc)} USDC per day.</p>
<div class="links"><a href="/board">Board</a><a href="/activity">Activity ledger</a><a href="/demo">Demo video</a><a href="${REPO_URL}" rel="noopener">Source on GitHub (MIT)</a></div>
</section>
</main>
<footer>vet402 on Algorand · <a href="https://vet402.com">vet402.com</a></footer>
</body></html>`;
}

export const DEMO_VIDEO_URL = "https://github.com/kzmttkc/vet402-algorand/releases/download/demo-2026-09-27/vet402-algorand-demo-v3.mp4";

export function demoHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 demo</title>
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/icon-512.png">
<style>body{margin:0;background:#0a0e17;color:#e8ecf3;font:16px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:24px auto;padding:0 16px}video{width:100%;border-radius:8px;background:#000}a{color:#93c5fd}</style>
</head><body><main>
<h1>vet402 on Algorand: demo</h1>
<video controls preload="metadata" playsinline src="${DEMO_VIDEO_URL}"></video>
<p><a href="${DEMO_VIDEO_URL}">Download the video (MP4)</a> &middot; <a href="/board?view=census">Census board</a> &middot; <a href="/activity">Activity ledger</a> &middot; <a href="https://github.com/kzmttkc/vet402-algorand">Source</a></p>
</main></body></html>`;
}
