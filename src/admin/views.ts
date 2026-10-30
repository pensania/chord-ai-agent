import type { Actor, QueueItem } from "../ops/operations.js";
import { STAGE_LABEL, customerMessage } from "../ops/operations.js";
import { ROLES, type RotaEntry, type Role, type Staff, type Stage } from "../ops/types.js";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

export const ROLE_LABEL: Record<Role, string> = { intake: "Order intake", kitchen: "Kitchen", dispatch: "Dispatch", rider: "Rider" };

const MOVE_LABEL: Partial<Record<Stage, string>> = {
  accepted: "Accept",
  cooking: "Start cooking",
  ready: "Mark ready",
  out_for_delivery: "Send out",
  delivered: "Delivered",
  picked_up: "Picked up",
  cancelled: "Cancel",
};

const BOARD: Stage[] = ["new", "accepted", "cooking", "ready", "out_for_delivery"];

/** One colour per stage, used for the column dot, the stage pill and the timeline. */
const STAGE_TONE: Record<Stage, string> = {
  new: "amber",
  accepted: "blue",
  cooking: "coral",
  ready: "green",
  out_for_delivery: "violet",
  delivered: "green",
  picked_up: "green",
  cancelled: "grey",
};

const COLUMN_TITLE: Partial<Record<Stage, string>> = {
  new: "New",
  accepted: "Accepted",
  cooking: "Cooking",
  ready: "Ready",
  out_for_delivery: "On the road",
};

const ICON = {
  queue: `<path d="M4 6h16M4 12h16M4 18h10"/>`,
  done: `<path d="M20 6 9 17l-5-5"/>`,
  rota: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  staff: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5"/>`,
  out: `<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  pin: `<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>`,
  phone: `<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>`,
  chat: `<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z"/>`,
  back: `<path d="M15 18l-6-6 6-6"/>`,
  fwd: `<path d="M9 18l6-6-6-6"/>`,
  stock: `<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>`,
  money: `<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>`,
  pay: `<path d="M4 7h16v12H4z"/><path d="M8 7V5h8v2M4 12h16"/>`,
  alert: `<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18h.01"/>`,
};
export const icon = (name: keyof typeof ICON, size = 18) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/** "Musa (rider)" → "Musa". */
export const shortName = (name: string) => name.replace(/\s*\(.*\)$/, "");

const AVATAR_TONES = ["#0f7b5f", "#b4552d", "#3b5bdb", "#8a4fbf", "#a07a12", "#2b7a99"];
export function avatar(s: Staff | undefined, size = 26) {
  if (!s) return "";
  const n = shortName(s.name);
  const initials = n.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
  const tone = AVATAR_TONES[[...s.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR_TONES.length];
  return `<span class="av" style="--av:${tone};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" title="${esc(s.name)}">${esc(initials)}</span>`;
}

const stagePill = (stage: Stage) => `<span class="pill t-${STAGE_TONE[stage]}"><i></i>${esc(STAGE_LABEL[stage])}</span>`;

const fmtTime = (iso?: string) => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "");

const prettyDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

const CSS = `
:root{--bg:#f6f4ef;--surface:#fff;--sunk:#efece5;--ink:#17201b;--ink-2:#3c4640;--quiet:#6b746e;--line:#e6e2d9;--line-2:#d9d4c8;
  --brand:#0d4a37;--brand-ink:#f4efe4;--accent:#0f7b5f;--accent-2:#118a6a;--gold:#e8a33d;--danger:#b42318;--ring:rgba(15,123,95,.2);
  --shadow:0 1px 2px rgba(23,32,27,.05),0 4px 14px rgba(23,32,27,.05);--shadow-lg:0 2px 6px rgba(23,32,27,.06),0 18px 40px rgba(23,32,27,.08);
  --amber:#b7791f;--blue:#3b5bdb;--coral:#c2410c;--green:#0f7b5f;--violet:#7c3aed;--grey:#6b746e}
@media (prefers-color-scheme:dark){:root{--bg:#0e1210;--surface:#161b18;--sunk:#121614;--ink:#eef2ef;--ink-2:#c9d1cc;--quiet:#94a09a;--line:#252c28;--line-2:#323a35;
  --brand:#0b2c22;--accent:#3ccf9e;--accent-2:#2fb98b;--danger:#f97066;--ring:rgba(60,207,158,.22);
  --shadow:0 1px 2px rgba(0,0,0,.3);--shadow-lg:0 12px 32px rgba(0,0,0,.35);
  --amber:#f0b44c;--blue:#7b93f5;--coral:#fb8a5c;--green:#3ccf9e;--violet:#b18cf7;--grey:#94a09a}}
*{box-sizing:border-box}html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.i{flex:none}
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:28px;padding:22px 16px;color:var(--brand-ink);
  background:radial-gradient(420px 300px at 120% -10%,rgba(232,163,61,.22),transparent 60%),linear-gradient(170deg,#0b3a2c,#0d4a37 60%,#0a2f24)}
.mark{display:flex;align-items:center;gap:10px;font-weight:600;padding:0 6px}.mark svg{width:34px;height:34px}
.mark small{display:block;font-weight:400;font-size:12px;color:rgba(244,239,228,.65)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;color:rgba(244,239,228,.78);font-weight:500;text-decoration:none}
.nav a:hover{background:rgba(255,255,255,.07);color:#fff}
.nav a.on{background:rgba(255,255,255,.12);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.me{margin-top:auto;display:flex;align-items:center;gap:10px;padding:12px 8px 0;border-top:1px solid rgba(255,255,255,.1)}
.me .who{flex:1;min-width:0;font-size:13px}.me .who b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me .who span{color:rgba(244,239,228,.6);font-size:12px}
.me button{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;border:0;background:transparent;color:rgba(244,239,228,.75);cursor:pointer}
.me button:hover{background:rgba(255,255,255,.1);color:#fff}
.me .av{box-shadow:0 0 0 2px rgba(255,255,255,.18)}
.content{min-width:0;padding:28px 28px 48px;max-width:1500px}
.top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px;margin-bottom:22px}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--quiet);margin:0 0 4px}
h1{font:600 28px/1.15 Fraunces,Georgia,serif;letter-spacing:-.4px;margin:0}
h2{font:600 15px/1.3 Inter,system-ui,sans-serif;margin:0}
.sub{color:var(--quiet);margin:6px 0 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)}
.panel-b{padding:16px 18px}
.muted{color:var(--quiet);font-size:13px}
.flash{display:flex;gap:10px;align-items:center;padding:11px 14px;margin-bottom:18px;border-radius:12px;font-size:14px;background:color-mix(in srgb,var(--gold) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--gold) 40%,transparent)}
/* stat tiles */
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-bottom:18px}
.stat{padding:14px 16px}.stat .k{font-size:12.5px;color:var(--quiet);font-weight:500}
.stat .v{font:600 26px/1.15 Fraunces,Georgia,serif;letter-spacing:-.3px;margin-top:4px;font-variant-numeric:tabular-nums}
.stat.alert .v{color:var(--danger)}
/* duty */
.duty{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-bottom:22px}
.duty>div{padding:12px 16px;border-left:1px solid var(--line)}.duty>div:first-child{border-left:0}
.duty .k{font-size:12px;color:var(--quiet);font-weight:500;margin-bottom:6px}
.people{display:flex;flex-wrap:wrap;gap:6px 10px}.person{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:500}
.gap{color:var(--danger);font-size:13px;font-weight:500}
.av{display:inline-grid;place-items:center;border-radius:50%;background:var(--av);color:#fff;font-weight:600;letter-spacing:.02em;flex:none}
/* board */
.board{display:grid;grid-template-columns:repeat(5,minmax(212px,1fr));gap:14px;overflow-x:auto;padding-bottom:6px;align-items:start}
.col{background:var(--sunk);border:1px solid var(--line);border-radius:16px;padding:10px;min-height:160px}
.col-h{display:flex;align-items:center;gap:8px;padding:4px 6px 10px;font-weight:600;font-size:13.5px}
.col-h .n{margin-left:auto;min-width:24px;height:22px;padding:0 7px;display:grid;place-items:center;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.dot{width:8px;height:8px;border-radius:50%;background:var(--tone)}
.empty{display:grid;place-items:center;height:96px;border:1.5px dashed var(--line-2);border-radius:12px;color:var(--quiet);font-size:13px}
.ticket{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 12px 12px 15px;margin-bottom:10px;box-shadow:var(--shadow);transition:box-shadow .15s,transform .15s}
.ticket::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--tone)}
.ticket:hover{box-shadow:var(--shadow-lg)}
.ticket .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ref{white-space:nowrap;font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;color:var(--ink)}
.ticket .name{font-weight:600;margin:6px 0 2px}
.meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;color:var(--quiet);font-size:12.5px}.meta span{display:inline-flex;align-items:center;gap:4px}
.items{margin:8px 0 0;padding:8px 0 0;border-top:1px dashed var(--line);list-style:none;font-size:13px;color:var(--ink-2)}
.items li{display:flex;gap:6px}.items b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
.crew{display:flex;align-items:center;gap:-4px}.crew .av{margin-right:-6px;box-shadow:0 0 0 2px var(--surface)}
.badge{white-space:nowrap;display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:var(--sunk);color:var(--ink-2);border:1px solid var(--line)}
.badge.today{background:color-mix(in srgb,var(--amber) 14%,transparent);border-color:color-mix(in srgb,var(--amber) 30%,transparent);color:var(--amber)}
.badge.late{background:color-mix(in srgb,var(--danger) 12%,transparent);border-color:color-mix(in srgb,var(--danger) 28%,transparent);color:var(--danger)}
.total{font-weight:600;font-variant-numeric:tabular-nums}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.actions form{display:flex;gap:6px;flex:1 1 auto}.actions form select{flex:1;min-width:0}
.t-amber{--tone:var(--amber)}.t-blue{--tone:var(--blue)}.t-coral{--tone:var(--coral)}.t-green{--tone:var(--green)}.t-violet{--tone:var(--violet)}.t-grey{--tone:var(--grey)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12.5px;font-weight:500;color:var(--tone);background:color-mix(in srgb,var(--tone) 12%,transparent);border:1px solid color-mix(in srgb,var(--tone) 26%,transparent)}
.pill i{width:6px;height:6px;border-radius:50%;background:var(--tone)}
/* controls */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 12px;font:inherit;font-size:13px;font-weight:600;border-radius:9px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none;white-space:nowrap;transition:filter .15s,background .15s}
button:hover,.btn:hover{background:var(--sunk);text-decoration:none}
button.primary,.btn.primary{border:0;color:#fff;background:linear-gradient(180deg,var(--accent-2),#0d6e54);box-shadow:0 1px 0 rgba(255,255,255,.15) inset,0 4px 10px rgba(13,110,84,.22)}
button.primary:hover,.btn.primary:hover{filter:brightness(1.06)}
button.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
button.danger:hover{background:color-mix(in srgb,var(--danger) 8%,transparent)}
.btn.wa{border:0;color:#fff;background:#1fa855;box-shadow:0 4px 10px rgba(31,168,85,.22)}.btn.wa:hover{filter:brightness(1.05);background:#1fa855}
.btn.ghost{border-color:transparent;background:transparent}.btn.ghost:hover{background:var(--sunk)}
input,select{font:inherit;font-size:14px;height:38px;padding:0 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);color:var(--ink);outline:none}
select{height:34px;font-size:13px;padding:0 8px}
input[type=checkbox]{height:16px;width:16px;padding:0}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--ring)}
form.inline{display:inline}
/* tables */
.tbl{width:100%;border-collapse:separate;border-spacing:0}
.tbl th{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--quiet);text-align:left;padding:10px 18px;background:var(--sunk);border-bottom:1px solid var(--line)}
.tbl td{padding:12px 18px;border-bottom:1px solid var(--line);vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}.tbl tbody tr:hover td{background:color-mix(in srgb,var(--sunk) 60%,transparent)}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
/* order page */
.split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:18px;align-items:start}
.stack{display:grid;gap:18px}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.fact .k{font-size:12px;color:var(--quiet);font-weight:500;margin-bottom:2px}.fact .v{font-weight:500}
.lines td:first-child{width:56px;color:var(--quiet);font-variant-numeric:tabular-nums}
.sum td{font-weight:600;font-size:15px}
.quote{margin:12px 0 0;padding:12px 14px;border-radius:12px;background:var(--sunk);border:1px solid var(--line);color:var(--ink-2);font-size:13.5px}
.tl{list-style:none;margin:0;padding:0}
.tl li{position:relative;padding:0 0 16px 24px}.tl li:last-child{padding-bottom:0}
.tl li::before{content:"";position:absolute;left:5px;top:16px;bottom:-2px;width:2px;background:var(--line)}.tl li:last-child::before{display:none}
.tl li i{position:absolute;left:0;top:5px;width:12px;height:12px;border-radius:50%;background:var(--surface);border:3px solid var(--tone)}
.tl .when{font-size:12px;color:var(--quiet)}
.stack-actions .actions{margin-top:0}.stack-actions .actions form{flex:1 1 100%}.stack-actions .actions button{flex:1}
.backlink{display:inline-flex;align-items:center;gap:4px;color:var(--quiet);font-size:13px;font-weight:500;margin-bottom:10px}
/* rota & staff */
.weeknav{display:flex;align-items:center;gap:6px}
.rota th:first-child,.rota td:first-child{position:sticky;left:0;background:var(--surface);z-index:1}
.rota th:first-child{background:var(--sunk)}
.rota td{min-width:130px;vertical-align:top}.rota .today{background:color-mix(in srgb,var(--accent) 6%,transparent)}
.rota th.today{color:var(--accent)}
.rolename{font-weight:600;white-space:nowrap}
.chips{display:flex;flex-direction:column;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;border-radius:999px;font-size:13px;border:1px solid var(--line);background:var(--surface);cursor:pointer;user-select:none;width:max-content}
.chip input{position:absolute;opacity:0;pointer-events:none}
.chip:has(input:checked){border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 10%,var(--surface));color:var(--ink)}
.chip:not(:has(input:checked)) .av{filter:grayscale(1);opacity:.45}
.chip:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.savebar{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--line)}
.roles{display:flex;flex-wrap:wrap;gap:6px}
.form{display:grid;gap:14px}.form label.lbl{display:block;font-size:13px;font-weight:500;margin-bottom:6px}.form input:not([type=checkbox]){width:100%}
.checks{display:flex;flex-wrap:wrap;gap:8px}
.check{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;border:1px solid var(--line-2);font-size:13.5px;cursor:pointer}
.check:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.check input{accent-color:var(--accent);margin:0}
.status{display:inline-flex;align-items:center;gap:6px;font-size:13px}.status i{width:7px;height:7px;border-radius:50%;background:var(--green)}.status.off i{background:var(--grey)}
.warn{color:var(--danger);font-weight:500;white-space:nowrap}
/* stock & money */
.countform,.rateform{display:flex;gap:6px;align-items:center}.countform input{width:90px;height:34px}.rateform input{width:110px;height:34px}.rateform select{width:auto}
.recipes{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.recipe .panel-h{align-items:flex-start}.recipe h2{margin-bottom:2px}
.narrowpanel{margin-bottom:8px}
.grid4{display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:12px;align-items:end}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bars{display:grid;gap:10px}.bar{display:grid;grid-template-columns:140px 1fr auto;gap:12px;align-items:center;font-size:13.5px}
.bar>div{height:8px;border-radius:999px;background:var(--sunk);overflow:hidden}.bar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.prows{display:grid;gap:8px}.prow{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:8px}.nowrap{white-space:nowrap}.prow select{height:38px}.prow input{width:100%}
.flash .i{color:var(--amber)}
@media (max-width:1180px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.split{grid-template-columns:1fr}.order>.stack:last-child{order:-1}}
@media (max-width:860px){
  .app{grid-template-columns:1fr}
  .side{position:sticky;top:0;z-index:5;height:auto;flex-direction:row;align-items:center;gap:8px;padding:10px 12px;overflow-x:auto}
  .mark{padding:0}.mark span{display:none}.nav{flex-direction:row}.nav a{padding:8px 10px}.nav a span{display:none}
  .me{margin:0 0 0 auto;padding:0;border:0}.me .who{display:none}
  .content{padding:20px 16px 40px}h1{font-size:24px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat{padding:10px 12px}.stat .v{font-size:20px}.stats .stat:last-child{grid-column:span 2}
  .duty{grid-template-columns:repeat(2,minmax(0,1fr))}.duty>div:nth-child(3){border-left:0}.duty>div:nth-child(n+3){border-top:1px solid var(--line)}
  .board{grid-template-columns:repeat(5,minmax(78vw,1fr));scroll-snap-type:x mandatory}.col{scroll-snap-align:start}
  .facts{grid-template-columns:1fr 1fr}
  .grid4{grid-template-columns:1fr 1fr}.grid4>div:first-child{grid-column:span 2}
  .bar{grid-template-columns:100px 1fr auto}
}
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`;

const NAV: { href: string; label: string; icon: keyof typeof ICON; match: string[]; owner?: boolean; money?: boolean }[] = [
  { href: "/admin", label: "Order queue", icon: "queue", match: ["Queue", "Order"] },
  { href: "/admin/done", label: "Finished", icon: "done", match: ["Done"] },
  { href: "/admin/stock", label: "Stock", icon: "stock", match: ["Stock", "Recipe"], money: true },
  { href: "/admin/expenses", label: "Expenses", icon: "money", match: ["Expenses"], owner: true, money: true },
  { href: "/admin/pay", label: "Staff pay", icon: "pay", match: ["Pay"], owner: true, money: true },
  { href: "/admin/rota", label: "Rota", icon: "rota", match: ["Rota"] },
  { href: "/admin/staff", label: "Staff", icon: "staff", match: ["Staff"] },
];

/** Stock and money pages exist only when that module is switched on. */
let moneyNav = false;
export function showMoneyNav(on: boolean) {
  moneyNav = on;
}

export function layout(title: string, body: string, who?: string, flash?: string, section = title): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Mama Tola's Kitchen</title>${FONTS}<style>${CSS}</style></head>`;
  const note = flash ? `<div class="flash" role="status">${esc(flash)}</div>` : "";
  if (!who) return `${head}<body><main class="content">${note}${body}</main></body></html>`;
  const me: Staff = { id: who.toLowerCase(), name: who, phone: "", roles: [], active: true };
  const nav = NAV.filter((n) => (!n.money || moneyNav) && (!n.owner || who === "Owner")).map((n) => `<a href="${n.href}"${n.match.includes(section) ? ' class="on" aria-current="page"' : ""}>${icon(n.icon)}<span>${n.label}</span></a>`).join("");
  return `${head}<body><div class="app">
<aside class="side"><div class="mark">${LOGO}<span>Mama Tola's Kitchen<small>Back office</small></span></div>
<nav class="nav" aria-label="Main">${nav}</nav>
<div class="me">${avatar(me, 32)}<div class="who"><b>${esc(who)}</b><span>Signed in</span></div>
<form method="post" action="/admin/logout"><button type="submit" aria-label="Sign out" title="Sign out">${icon("out")}</button></form></div></aside>
<main class="content">${note}${body}</main></div></body></html>`;
}

const LOGIN_CSS = `
:root{--bg:#f7f5f0;--card:#fff;--ink:#17201b;--quiet:#66706a;--line:#e4e1d8;--brand:#0d4a37;--brand-2:#0f7b5f;--accent:#e8a33d;--danger:#b42318;--ring:rgba(15,123,95,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1311;--card:#171c19;--ink:#eef2ef;--quiet:#9aa59f;--line:#2a312d;--danger:#f97066;--ring:rgba(60,207,158,.22)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.shell{min-height:100%;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}
.brand{position:relative;overflow:hidden;color:#f4efe4;padding:48px 56px;display:flex;flex-direction:column;justify-content:space-between;
  background:radial-gradient(900px 520px at 110% -10%,rgba(232,163,61,.28),transparent 60%),radial-gradient(700px 600px at -20% 120%,rgba(15,123,95,.55),transparent 60%),linear-gradient(160deg,#0b3a2c,#0d4a37 55%,#0a2f24)}
.brand::after{content:"";position:absolute;inset:0;opacity:.07;background-image:radial-gradient(#fff 1px,transparent 1px);background-size:22px 22px;pointer-events:none}
.mark{display:flex;align-items:center;gap:12px;font-weight:600;letter-spacing:.2px;position:relative;z-index:1}
.mark svg{width:40px;height:40px}
.pitch{position:relative;z-index:1;max-width:440px}
.pitch h1{font:600 40px/1.12 Fraunces,Georgia,serif;letter-spacing:-.5px;margin:0 0 16px}
.pitch p{margin:0;color:rgba(244,239,228,.78);font-size:16px}
.facts{position:relative;z-index:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;font-size:13px;color:rgba(244,239,228,.7)}
.facts b{display:block;color:#f4efe4;font-size:15px;font-weight:600}
.panel{display:flex;align-items:center;justify-content:center;padding:48px 24px}
.card{width:100%;max-width:400px}
.card h2{font:600 26px/1.2 Fraunces,Georgia,serif;margin:0 0 6px;letter-spacing:-.3px}
.card .sub{color:var(--quiet);margin:0 0 28px}
.seg{display:grid;grid-template-columns:1fr 1fr;background:var(--line);border-radius:12px;padding:4px;margin-bottom:22px}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg label{text-align:center;padding:9px 0;border-radius:9px;font-size:14px;font-weight:500;color:var(--quiet);cursor:pointer;transition:background .15s,color .15s}
.seg input:checked+label{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08),0 1px 8px rgba(0,0,0,.04)}
.seg input:focus-visible+label{outline:2px solid var(--brand-2);outline-offset:2px}
.field{margin-bottom:16px}.field label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
.control{position:relative}
.control input{width:100%;height:48px;padding:0 14px;font:inherit;font-size:16px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;outline:none;transition:border-color .15s,box-shadow .15s}
.control input:focus{border-color:var(--brand-2);box-shadow:0 0 0 4px var(--ring)}
.control .peek{position:absolute;right:6px;top:6px;height:36px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--quiet);font:inherit;font-size:13px;cursor:pointer}
.control .peek:hover{background:var(--line);color:var(--ink)}
.hint{font-size:12.5px;color:var(--quiet);margin-top:6px}
.submit{width:100%;height:50px;margin-top:8px;border:0;border-radius:12px;font:inherit;font-size:15px;font-weight:600;color:#fff;cursor:pointer;
  background:linear-gradient(180deg,#118a6a,#0d6e54);box-shadow:0 1px 0 rgba(255,255,255,.15) inset,0 6px 16px rgba(13,110,84,.28);transition:transform .05s,filter .15s}
.submit:hover{filter:brightness(1.05)}.submit:active{transform:translateY(1px)}
.error{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;margin-bottom:18px;border-radius:12px;font-size:14px;color:var(--danger);background:color-mix(in srgb,var(--danger) 9%,transparent);border:1px solid color-mix(in srgb,var(--danger) 25%,transparent)}
.foot{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--quiet);display:flex;gap:8px;align-items:center}
.owner-only{display:none}
body.owner .staff-only{display:none}body.owner .owner-only{display:block}
@media (max-width:860px){.shell{grid-template-columns:1fr}.brand{padding:28px 24px;min-height:auto;gap:28px}.pitch h1{font-size:28px}.facts{display:none}.panel{padding:32px 16px 48px}}
`;

const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#f4efe4"/><path d="M9 22h22a11 11 0 0 1-22 0Z" fill="#0d4a37"/><path d="M7 21.5h26" stroke="#0d4a37" stroke-width="2" stroke-linecap="round"/><path d="M16 17c0-2 2-2 2-4M20.5 17c0-2 2-2 2-4" stroke="#e8a33d" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`;

export function loginPage(error?: string, mode: "staff" | "owner" = "staff"): string {
  const owner = mode === "owner";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Mama Tola's Kitchen</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${LOGIN_CSS}</style></head>
<body class="${owner ? "owner" : ""}">
<div class="shell">
  <aside class="brand">
    <div class="mark">${LOGO}<span>Mama Tola's Kitchen</span></div>
    <div class="pitch"><h1>Every order, from payment to the doorstep.</h1>
      <p>The kitchen's back office: the order queue, today's rota and every delivery in one place.</p></div>
    <div class="facts"><div><b>Verified</b>Only Paystack-confirmed orders</div><div><b>Assigned</b>Cooks and riders from the rota</div><div><b>Tracked</b>Every stage, every hand-off</div></div>
  </aside>
  <main class="panel">
    <div class="card">
      <h2>Welcome back</h2>
      <p class="sub">Sign in to manage today's orders.</p>
      ${error ? `<div class="error" role="alert"><span aria-hidden="true">!</span><span>${esc(error)}</span></div>` : ""}
      <form method="post" action="/admin/login" id="login">
        <div class="seg" role="radiogroup" aria-label="Sign in as">
          <input type="radio" name="mode" id="m-staff" value="staff"${owner ? "" : " checked"}><label for="m-staff">Staff</label>
          <input type="radio" name="mode" id="m-owner" value="owner"${owner ? " checked" : ""}><label for="m-owner">Owner</label>
        </div>
        <div class="field staff-only">
          <label for="who">WhatsApp number or staff ID</label>
          <div class="control"><input id="who" name="who" inputmode="tel" autocomplete="username" placeholder="0803 123 4567"></div>
        </div>
        <div class="field">
          <label for="secret"><span class="staff-only">PIN</span><span class="owner-only">Owner password</span></label>
          <div class="control"><input id="secret" name="secret" type="password" autocomplete="current-password" required><button type="button" class="peek" id="peek" aria-label="Show password">Show</button></div>
          <div class="hint staff-only">Your 4 to 8 digit PIN. The owner sets it on the Staff page.</div>
        </div>
        <button class="submit" type="submit">Sign in</button>
      </form>
      <div class="foot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Secure sign-in. You'll stay signed in for 12 hours.</div>
    </div>
  </main>
</div>
<script>
(function(){
  var body=document.body, who=document.getElementById("who"), secret=document.getElementById("secret");
  function sync(){ var o=document.getElementById("m-owner").checked; body.classList.toggle("owner",o); secret.inputMode=o?"text":"numeric"; }
  document.querySelectorAll('input[name="mode"]').forEach(function(r){ r.addEventListener("change",function(){ sync(); (r.value==="owner"?secret:who).focus(); }); });
  document.getElementById("peek").addEventListener("click",function(){ var show=secret.type==="password"; secret.type=show?"text":"password"; this.textContent=show?"Hide":"Show"; this.setAttribute("aria-label",show?"Hide password":"Show password"); });
  sync();
})();
</script>
</body></html>`;
}

const whatsappLink = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

function dueBadge(i: QueueItem, today: string) {
  const d = i.order.neededBy;
  if (!d) return `<span class="badge">${icon("clock", 13)}No date</span>`;
  const short = esc(new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }));
  if (d < today) return `<span class="badge late" title="Was due ${short}">${icon("clock", 13)}Overdue</span>`;
  if (d === today) return `<span class="badge today">${icon("clock", 13)}Due today</span>`;
  return `<span class="badge">${icon("clock", 13)}${short}</span>`;
}

function moveButtons(i: QueueItem, riders: Staff[]) {
  return i.nextStages
    .map((to) => {
      const riderPick =
        to === "out_for_delivery" && riders.length
          ? `<select name="riderId" aria-label="Rider"><option value="">Auto-pick rider</option>${riders.map((r) => `<option value="${esc(r.id)}">${esc(shortName(r.name))}</option>`).join("")}</select>`
          : "";
      const back = to === "ready" && i.ops.stage === "out_for_delivery";
      const label = back ? "Back to kitchen" : (MOVE_LABEL[to] ?? to);
      const kind = back ? "" : to === "cancelled" ? "danger" : "primary";
      return `<form method="post" action="/admin/orders/${esc(i.order.reference)}/move">
<input type="hidden" name="to" value="${to}">${riderPick}<button class="${kind}">${esc(label)}</button></form>`;
    })
    .join("");
}

function ticket(i: QueueItem, today: string, riders: Staff[]) {
  const o = i.order;
  const items = o.lines.map((l) => `<li><b>${l.qty}×</b><span>${esc(l.name)}</span></li>`).join("");
  const crew = [i.cook, i.rider].filter(Boolean).map((s) => avatar(s, 24)).join("");
  const crewTitle = [i.cook && `Cook: ${shortName(i.cook.name)}`, i.rider && `Rider: ${shortName(i.rider.name)}`].filter(Boolean).join(" · ");
  return `<article class="ticket t-${STAGE_TONE[i.ops.stage]}">
<a class="ref" href="/admin/orders/${esc(o.reference)}">${esc(o.reference)}</a>
<div class="row name"><span>${esc(o.customerName)}</span><span class="total">${naira(o.totalNgn)}</span></div>
<div class="meta"><span>${icon("pin", 13)}${esc(o.deliveryZone)}</span>${dueBadge(i, today)}</div>
<ul class="items">${items}</ul>
${crew ? `<div class="foot"><span class="crew" title="${esc(crewTitle)}">${crew}</span><span class="muted">${esc([i.cook, i.rider].filter(Boolean).map((x) => shortName(x!.name)).join(" · "))}</span></div>` : ""}
${i.nextStages.length ? `<div class="actions">${moveButtons(i, riders)}</div>` : ""}
</article>`;
}

export function dutyStrip(duty: Record<Role, Staff[]>) {
  return `<section class="panel duty" aria-label="On duty today">${ROLES.map(
    (r) =>
      `<div><div class="k">${ROLE_LABEL[r]}</div><div class="people">${
        duty[r].length ? duty[r].map((s) => `<span class="person">${avatar(s, 22)}${esc(shortName(s.name))}</span>`).join("") : `<span class="gap">Nobody on the rota</span>`
      }</div></div>`,
  ).join("")}</section>`;
}

export function queuePage(items: QueueItem[], today: string, duty: Record<Role, Staff[]>, riders: Staff[], who: string, flash?: string, banner = "") {
  const dueToday = items.filter((i) => i.order.neededBy === today).length;
  const overdue = items.filter((i) => i.order.neededBy && i.order.neededBy < today).length;
  const onRoad = items.filter((i) => i.ops.stage === "out_for_delivery").length;
  const value = items.reduce((n, i) => n + i.order.totalNgn, 0);
  const stat = (k: string, v: string | number, cls = "") => `<div class="panel stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const cols = BOARD.map((stage) => {
    const here = items.filter((i) => i.ops.stage === stage);
    return `<section class="col t-${STAGE_TONE[stage]}" aria-label="${esc(STAGE_LABEL[stage])}"><div class="col-h"><span class="dot"></span>${esc(COLUMN_TITLE[stage] ?? STAGE_LABEL[stage])}<span class="n">${here.length}</span></div>${
      here.map((i) => ticket(i, today, riders)).join("") || `<div class="empty">Nothing here</div>`
    }</section>`;
  }).join("");
  const first = who.split(/\s+/)[0];
  return layout(
    "Queue",
    `<div class="top"><div><p class="eyebrow">${esc(prettyDate(today))}</p><h1>${who === "Owner" ? "Today's kitchen" : `Hello, ${esc(shortName(first))}`}</h1><p class="sub">Paid orders, soonest due first. Move each one along as it happens.</p></div></div>
${banner}<div class="stats">${stat("Open orders", items.length)}${stat("Due today", dueToday)}${stat("Overdue", overdue, overdue ? "alert" : "")}${stat("On the road", onRoad)}${stat("Value in progress", naira(value))}</div>
${dutyStrip(duty)}
<div class="board">${cols}</div>`,
    who,
    flash,
  );
}

export function donePage(items: QueueItem[], who: string) {
  const done = items
    .filter((i) => ["delivered", "picked_up", "cancelled"].includes(i.ops.stage))
    .sort((a, b) => (b.ops.history.at(-1)?.at ?? "").localeCompare(a.ops.history.at(-1)?.at ?? ""));
  const earned = done.filter((i) => i.ops.stage !== "cancelled").reduce((n, i) => n + i.order.totalNgn, 0);
  const rows = done
    .map(
      (i) =>
        `<tr><td><a class="ref" href="/admin/orders/${esc(i.order.reference)}">${esc(i.order.reference)}</a></td><td>${esc(i.order.customerName)}</td><td>${stagePill(i.ops.stage)}</td><td class="num">${naira(i.order.totalNgn)}</td><td class="muted">${fmtTime(i.ops.history.at(-1)?.at)}</td></tr>`,
    )
    .join("");
  return layout(
    "Done",
    `<div class="top"><div><p class="eyebrow">History</p><h1>Finished orders</h1><p class="sub">${done.length} closed · ${naira(earned)} delivered or picked up</p></div></div>
<div class="panel scroll"><table class="tbl"><thead><tr><th>Reference</th><th>Customer</th><th>Outcome</th><th class="num">Total</th><th>Closed (UTC)</th></tr></thead><tbody>${
      rows || `<tr><td colspan="5" class="muted">None yet. Orders show up here once they're delivered, picked up or cancelled.</td></tr>`
    }</tbody></table></div>`,
    who,
  );
}

export function orderPage(i: QueueItem, staffById: Map<string, Staff>, riders: Staff[], today: string, who: string, flash?: string) {
  const o = i.order;
  const msg = customerMessage(o, i.ops.stage, i.rider);
  const lines = o.lines.map((l) => `<tr><td>${l.qty}×</td><td>${esc(l.name)}</td><td class="num">${naira(l.lineTotalNgn)}</td></tr>`).join("");
  const history = [...i.ops.history]
    .reverse()
    .map(
      (h) =>
        `<li class="t-${STAGE_TONE[h.to]}"><i></i><div><b>${esc(STAGE_LABEL[h.to])}</b></div><div class="when">${fmtTime(h.at)} UTC · ${esc(h.by === "owner" ? "Owner" : shortName(staffById.get(h.by)?.name ?? h.by))}</div>${h.note ? `<div class="muted">${esc(h.note)}</div>` : ""}</li>`,
    )
    .join("");
  const address = o.deliveryAddress && o.deliveryAddress.toLowerCase() !== "pickup" ? o.deliveryAddress : "Pickup at the kitchen";
  const fact = (k: string, v: string) => `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const crew = (label: string, s?: Staff, phone = false) =>
    s ? `<span class="person">${avatar(s, 26)}<span>${esc(shortName(s.name))}<br><span class="muted">${label}${phone ? ` · ${esc(s.phone)}` : ""}</span></span></span>` : "";
  const update =
    i.ops.stage !== "new" && o.status === "paid"
      ? `<section class="panel"><div class="panel-h"><h2>Customer update</h2></div><div class="panel-b">
<a class="btn wa" target="_blank" rel="noopener" href="${esc(whatsappLink(o.customerPhone, msg))}">${icon("chat", 16)}Send this update on WhatsApp</a>
<p class="quote">“${esc(msg)}”</p></div></section>`
      : "";
  const team = [crew("Cook", i.cook), crew("Rider", i.rider, true)].filter(Boolean).join("");
  return layout(
    o.reference,
    `<a class="backlink" href="/admin">${icon("back", 14)}Order queue</a>
<div class="top"><div><p class="eyebrow ref">${esc(o.reference)}</p><h1>${esc(o.customerName)}</h1><p class="sub">${stagePill(i.ops.stage)} &nbsp;${dueBadge(i, today)}</p></div></div>
<div class="split order">
<div class="stack">
<section class="panel"><div class="panel-b"><div class="facts">
${fact("Phone", `<a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a>`)}${fact("Zone", esc(o.deliveryZone))}${fact("Address", esc(address))}
${fact("Payment", `${o.status === "paid" ? `<span class="status"><i></i>Paid</span>` : esc(o.status)}`)}${fact("Paid at", o.paidAt ? `${fmtTime(o.paidAt)} UTC` : "—")}${fact("Needed by", esc(o.neededBy ?? "Not given"))}
</div></div></section>
<section class="panel"><div class="panel-h"><h2>Items</h2><span class="muted">${o.lines.length} line${o.lines.length === 1 ? "" : "s"}</span></div>
<table class="tbl lines"><tbody>${lines}<tr><td></td><td class="muted">Delivery</td><td class="num">${naira(o.deliveryFeeNgn)}</td></tr><tr class="sum"><td></td><td>Total</td><td class="num">${naira(o.totalNgn)}</td></tr></tbody></table></section>
<section class="panel"><div class="panel-h"><h2>History</h2></div><div class="panel-b">${history ? `<ol class="tl">${history}</ol>` : `<p class="muted" style="margin:0">No changes yet. The first move starts the timeline.</p>`}</div></section>
</div>
<div class="stack">
${i.nextStages.length ? `<section class="panel stack-actions"><div class="panel-h"><h2>Next step</h2></div><div class="panel-b"><div class="actions">${moveButtons(i, riders)}</div></div></section>` : ""}
${update}
<section class="panel"><div class="panel-h"><h2>Team</h2></div><div class="panel-b"><div class="people" style="flex-direction:column;gap:12px">${team || `<span class="muted">A cook is assigned when the order is accepted.</span>`}</div></div></section>
</div>
</div>`,
    who,
    flash,
    "Order",
  );
}

export function rotaPage(week: string[], rota: RotaEntry[], staff: Staff[], canEdit: boolean, who: string, flash?: string) {
  const on = (date: string, role: Role, id: string) => rota.some((r) => r.date === date && r.role === role && r.staffId === id);
  const prev = week[0] && new Date(Date.parse(`${week[0]}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
  const next = week[0] && new Date(Date.parse(`${week[0]}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const range = `${day(week[0])} – ${day(week[6])}`;
  const rows = ROLES.map((role) => {
    const people = staff.filter((s) => s.active && s.roles.includes(role));
    const cells = week
      .map((d) => {
        const cls = d === today ? ' class="today"' : "";
        if (!canEdit) {
          const names = people.filter((s) => on(d, role, s.id)).map((s) => `<span class="person">${avatar(s, 22)}${esc(shortName(s.name))}</span>`);
          return `<td${cls}><div class="chips">${names.join("") || `<span class="muted">—</span>`}</div></td>`;
        }
        return `<td${cls}><div class="chips">${
          people
            .map((s) => `<label class="chip"><input type="checkbox" name="${esc(`${d}|${role}`)}" value="${esc(s.id)}"${on(d, role, s.id) ? " checked" : ""}>${avatar(s, 22)}${esc(shortName(s.name))}</label>`)
            .join("") || `<span class="muted">Nobody has this role</span>`
        }</div></td>`;
      })
      .join("");
    return `<tr><td class="rolename">${ROLE_LABEL[role]}</td>${cells}</tr>`;
  }).join("");
  const table = `<div class="scroll"><table class="tbl rota"><thead><tr><th>Role</th>${week.map((d) => `<th${d === today ? ' class="today"' : ""}>${esc(day(d))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const body = canEdit
    ? `<form method="post" action="/admin/rota" class="panel"><input type="hidden" name="week" value="${esc(week[0])}">${table}<div class="savebar"><span class="muted" style="margin-right:auto;align-self:center">Tap a name to put them on or off duty.</span><button class="primary">Save rota</button></div></form>`
    : `<div class="panel">${table}</div>`;
  return layout(
    "Rota",
    `<div class="top"><div><p class="eyebrow">Week of ${esc(range)}</p><h1>Rota</h1><p class="sub">Who's on duty. New orders go to the least busy cook and rider on today's rota.</p></div>
<div class="weeknav"><a class="btn" href="/admin/rota?week=${esc(prev)}">${icon("back", 15)}Previous</a><a class="btn ghost" href="/admin/rota">This week</a><a class="btn" href="/admin/rota?week=${esc(next)}">Next${icon("fwd", 15)}</a></div></div>
${body}`,
    who,
    flash,
  );
}

export function staffPage(staff: Staff[], canEdit: boolean, who: string, flash?: string, editing?: Staff) {
  const rows = staff
    .map(
      (s) =>
        `<tr><td><span class="person">${avatar(s, 30)}<span>${esc(shortName(s.name))}</span></span></td><td class="muted">${esc(s.phone)}</td><td><div class="roles">${s.roles.map((r) => `<span class="badge">${ROLE_LABEL[r]}</span>`).join("")}</div></td><td><span class="status${s.active ? "" : " off"}"><i></i>${s.active ? "Active" : "Inactive"}</span></td><td>${
          s.pinHash ? `<span class="muted">Set</span>` : `<span class="warn">Not set</span>`
        }</td>${canEdit ? `<td class="num"><a class="btn ghost" href="/admin/staff?edit=${esc(s.id)}">Edit</a></td>` : ""}</tr>`,
    )
    .join("");
  const table = `<div class="panel scroll"><table class="tbl"><thead><tr><th>Name</th><th>WhatsApp</th><th>Roles</th><th>Status</th><th>PIN</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
  return layout(
    "Staff",
    `<div class="top"><div><p class="eyebrow">Team</p><h1>Staff</h1><p class="sub">${staff.filter((s) => s.active).length} active · Staff sign in with their number and PIN.</p></div></div>
${canEdit ? `<div class="split">${table}${staffForm(editing)}</div>` : table}`,
    who,
    flash,
  );
}

export function staffForm(s?: Staff) {
  return `<section class="panel"><div class="panel-h"><h2>${s ? `Edit ${esc(shortName(s.name))}` : "Add a staff member"}</h2>${s ? `<a class="muted" href="/admin/staff">Cancel</a>` : ""}</div>
<form method="post" action="/admin/staff" class="panel-b form">${s ? `<input type="hidden" name="id" value="${esc(s.id)}">` : ""}
<div><label class="lbl" for="name">Name</label><input id="name" name="name" required value="${esc(s?.name)}"></div>
<div><label class="lbl" for="phone">WhatsApp number</label><input id="phone" name="phone" required inputmode="tel" value="${esc(s?.phone)}"></div>
<div><span class="lbl" style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Roles</span><div class="checks">${ROLES.map((r) => `<label class="check"><input type="checkbox" name="roles" value="${r}"${s?.roles.includes(r) ? " checked" : ""}>${ROLE_LABEL[r]}</label>`).join("")}</div></div>
<div class="checks"><label class="check"><input type="checkbox" name="active" value="1"${!s || s.active ? " checked" : ""}>Active</label></div>
<div><label class="lbl" for="pin">${s?.pinHash ? "New PIN (leave empty to keep)" : "PIN (4 to 8 digits)"}</label><input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password"></div>
<div><button class="primary">Save</button></div></form></section>`;
}

export function actorName(a: Actor) {
  return a.kind === "owner" ? "Owner" : a.staff.name;
}
