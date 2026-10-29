import type { Actor, QueueItem } from "../ops/operations.js";
import { STAGE_LABEL, customerMessage } from "../ops/operations.js";
import { ROLES, type RotaEntry, type Role, type Staff, type Stage } from "../ops/types.js";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

const ROLE_LABEL: Record<Role, string> = { intake: "Order intake", kitchen: "Kitchen", dispatch: "Dispatch", rider: "Rider" };

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

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--quiet:#6b6a66;--line:#e2e0da;--accent:#0f7b5f;--warn:#b54708;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#f0efea;--quiet:#a3a29c;--line:#34332f;--accent:#3ccf9e;--warn:#f79009;--danger:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header strong{margin-right:auto}header a{color:var(--ink)}main{padding:16px;max-width:1400px;margin:0 auto}
a{color:var(--accent)}h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:0 0 8px}
.board{display:grid;grid-template-columns:repeat(5,minmax(220px,1fr));gap:12px;overflow-x:auto}
.col{background:transparent}.col h2{display:flex;justify-content:space-between;color:var(--quiet);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px}
.card .ref{font-weight:600}.muted{color:var(--quiet);font-size:13px}.due{font-size:13px}.late{color:var(--danger);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button,.btn{font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}
form.inline{display:inline}table{border-collapse:collapse;width:100%;background:var(--card)}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font-size:13px;color:var(--quiet)}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
label{display:block;margin:8px 0 4px;font-size:13px;color:var(--quiet)}.flash{padding:8px 12px;border-radius:6px;background:var(--card);border:1px solid var(--warn);margin-bottom:12px}
.duty{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px}.duty>div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.narrow{max-width:420px}.chk{display:inline-flex;gap:4px;align-items:center;margin-right:10px;font-size:13px;color:var(--ink)}
@media (max-width:700px){.board{grid-template-columns:1fr}}
`;

export function layout(title: string, body: string, who?: string, flash?: string): string {
  const nav = who
    ? `<a href="/admin">Queue</a><a href="/admin/done">Done</a><a href="/admin/rota">Rota</a><a href="/admin/staff">Staff</a>
       <span class="muted">${esc(who)}</span><form class="inline" method="post" action="/admin/logout"><button>Sign out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Mama Tola's Kitchen</title><style>${CSS}</style></head>
<body><header><strong>Mama Tola's Kitchen</strong>${nav}</header><main>${flash ? `<div class="flash">${esc(flash)}</div>` : ""}${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "Sign in",
    `<div class="narrow"><h1>Staff sign-in</h1>
<form method="post" action="/admin/login">
<label for="who">Phone number, or "owner"</label><input id="who" name="who" autocomplete="username" required>
<label for="secret">PIN or owner password</label><input id="secret" name="secret" type="password" autocomplete="current-password" required>
<p><button class="primary">Sign in</button></p></form>
<p class="muted">Ask the owner to set your PIN on the Staff page.</p></div>`,
    undefined,
    error,
  );
}

const whatsappLink = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

function dueLabel(i: QueueItem, today: string) {
  const d = i.order.neededBy;
  if (!d) return `<span class="due muted">No date given</span>`;
  const late = d < today;
  return `<span class="due ${late ? "late" : ""}">${d === today ? "Due today" : `Due ${esc(d)}`}${late ? " (overdue)" : ""}</span>`;
}

function moveButtons(i: QueueItem, riders: Staff[]) {
  return i.nextStages
    .map((to) => {
      const riderPick =
        to === "out_for_delivery" && riders.length
          ? `<select name="riderId" aria-label="Rider"><option value="">Auto-pick rider</option>${riders.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</select>`
          : "";
      const cls = to === "cancelled" ? "danger" : "primary";
      const label = to === "ready" && i.ops.stage === "out_for_delivery" ? "Back to kitchen" : (MOVE_LABEL[to] ?? to);
      const kind = label === "Back to kitchen" ? "" : cls;
      return `<form class="inline" method="post" action="/admin/orders/${esc(i.order.reference)}/move">
<input type="hidden" name="to" value="${to}">${riderPick}<button class="${kind}">${esc(label)}</button></form>`;
    })
    .join("");
}

function card(i: QueueItem, today: string, riders: Staff[]) {
  const items = i.order.lines.map((l) => `${l.qty} × ${esc(l.name)}`).join("<br>");
  const who = [i.cook && `Cook: ${esc(i.cook.name)}`, i.rider && `Rider: ${esc(i.rider.name)}`].filter(Boolean).join(" · ");
  return `<div class="card"><a class="ref" href="/admin/orders/${esc(i.order.reference)}">${esc(i.order.reference)}</a>
<div>${esc(i.order.customerName)} · ${esc(i.order.deliveryZone)}</div><div class="muted">${items}</div>
<div>${dueLabel(i, today)}</div>${who ? `<div class="muted">${who}</div>` : ""}
<div class="actions">${moveButtons(i, riders)}</div></div>`;
}

export function dutyStrip(duty: Record<Role, Staff[]>) {
  return `<div class="duty">${ROLES.map((r) => `<div><div class="muted">${ROLE_LABEL[r]} today</div>${duty[r].length ? duty[r].map((s) => esc(s.name)).join(", ") : `<span class="late">Nobody on the rota</span>`}</div>`).join("")}</div>`;
}

export function queuePage(items: QueueItem[], today: string, duty: Record<Role, Staff[]>, riders: Staff[], who: string, flash?: string) {
  const cols = BOARD.map((stage) => {
    const here = items.filter((i) => i.ops.stage === stage);
    return `<section class="col"><h2><span>${esc(STAGE_LABEL[stage])}</span><span>${here.length}</span></h2>${here.map((i) => card(i, today, riders)).join("") || `<p class="muted">Nothing here</p>`}</section>`;
  }).join("");
  return layout("Queue", `<h1>Order queue</h1>${dutyStrip(duty)}<div class="board">${cols}</div>`, who, flash);
}

export function donePage(items: QueueItem[], who: string) {
  const rows = items
    .filter((i) => ["delivered", "picked_up", "cancelled"].includes(i.ops.stage))
    .sort((a, b) => (b.ops.history.at(-1)?.at ?? "").localeCompare(a.ops.history.at(-1)?.at ?? ""))
    .map((i) => `<tr><td><a href="/admin/orders/${esc(i.order.reference)}">${esc(i.order.reference)}</a></td><td>${esc(i.order.customerName)}</td><td>${esc(STAGE_LABEL[i.ops.stage])}</td><td>${naira(i.order.totalNgn)}</td><td>${esc(i.ops.history.at(-1)?.at.slice(0, 16).replace("T", " "))}</td></tr>`)
    .join("");
  return layout("Done", `<h1>Finished orders</h1><table><tr><th>Reference</th><th>Customer</th><th>Outcome</th><th>Total</th><th>Closed (UTC)</th></tr>${rows || `<tr><td colspan="5" class="muted">None yet</td></tr>`}</table>`, who);
}

export function orderPage(i: QueueItem, staffById: Map<string, Staff>, riders: Staff[], today: string, who: string, flash?: string) {
  const o = i.order;
  const msg = customerMessage(o, i.ops.stage, i.rider);
  const lines = o.lines.map((l) => `<tr><td>${l.qty}</td><td>${esc(l.name)}</td><td>${naira(l.lineTotalNgn)}</td></tr>`).join("");
  const history = i.ops.history
    .map((h) => `<tr><td>${esc(h.at.slice(0, 16).replace("T", " "))}</td><td>${esc(STAGE_LABEL[h.from])} → ${esc(STAGE_LABEL[h.to])}</td><td>${esc(h.by === "owner" ? "Owner" : (staffById.get(h.by)?.name ?? h.by))}</td><td>${esc(h.note ?? "")}</td></tr>`)
    .join("");
  const update =
    i.ops.stage !== "new" && o.status === "paid"
      ? `<p><a class="btn primary" target="_blank" rel="noopener" href="${esc(whatsappLink(o.customerPhone, msg))}">Send this update on WhatsApp</a></p><p class="muted">“${esc(msg)}”</p>`
      : "";
  return layout(
    o.reference,
    `<h1>${esc(o.reference)} · ${esc(STAGE_LABEL[i.ops.stage])}</h1>
<p>${esc(o.customerName)} · ${esc(o.customerPhone)} · ${esc(o.deliveryZone)}${o.deliveryAddress && o.deliveryAddress.toLowerCase() !== "pickup" ? ` · ${esc(o.deliveryAddress)}` : ""}</p>
<p>${dueLabel(i, today)} · Payment: ${esc(o.status)}${o.paidAt ? ` (${esc(o.paidAt.slice(0, 16).replace("T", " "))} UTC)` : ""}</p>
<p class="muted">${[i.cook && `Cook: ${esc(i.cook.name)}`, i.rider && `Rider: ${esc(i.rider.name)} (${esc(i.rider.phone)})`].filter(Boolean).join(" · ")}</p>
<table><tr><th>Qty</th><th>Item</th><th>Line total</th></tr>${lines}<tr><td></td><td>Delivery</td><td>${naira(o.deliveryFeeNgn)}</td></tr><tr><th></th><th>Total</th><th>${naira(o.totalNgn)}</th></tr></table>
<div class="actions">${moveButtons(i, riders)}</div>
${update}
<h2 style="margin-top:20px">History</h2><table><tr><th>When (UTC)</th><th>Change</th><th>By</th><th>Note</th></tr>${history || `<tr><td colspan="4" class="muted">No changes yet</td></tr>`}</table>`,
    who,
    flash,
  );
}

export function rotaPage(week: string[], rota: RotaEntry[], staff: Staff[], canEdit: boolean, who: string, flash?: string) {
  const on = (date: string, role: Role, id: string) => rota.some((r) => r.date === date && r.role === role && r.staffId === id);
  const prev = week[0] && new Date(Date.parse(`${week[0]}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
  const next = week[0] && new Date(Date.parse(`${week[0]}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10);
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const rows = ROLES.map((role) => {
    const people = staff.filter((s) => s.active && s.roles.includes(role));
    const cells = week
      .map((d) => {
        if (!canEdit) {
          const names = people.filter((s) => on(d, role, s.id)).map((s) => esc(s.name));
          return `<td>${names.join("<br>") || `<span class="muted">—</span>`}</td>`;
        }
        return `<td>${people.map((s) => `<label class="chk"><input type="checkbox" name="${esc(`${d}|${role}`)}" value="${esc(s.id)}"${on(d, role, s.id) ? " checked" : ""}>${esc(s.name)}</label>`).join("<br>") || `<span class="muted">Nobody has this role</span>`}</td>`;
      })
      .join("");
    return `<tr><th>${ROLE_LABEL[role]}</th>${cells}</tr>`;
  }).join("");
  const table = `<table><tr><th></th>${week.map((d) => `<th>${esc(day(d))}</th>`).join("")}</tr>${rows}</table>`;
  const body = canEdit
    ? `<form method="post" action="/admin/rota"><input type="hidden" name="week" value="${esc(week[0])}">${table}<p><button class="primary">Save rota</button></p></form>`
    : table;
  return layout("Rota", `<h1>Rota</h1><p><a href="/admin/rota?week=${esc(prev)}">← Previous week</a> · <a href="/admin/rota?week=${esc(next)}">Next week →</a></p>${body}`, who, flash);
}

export function staffPage(staff: Staff[], canEdit: boolean, who: string, flash?: string, editing?: Staff) {
  const rows = staff
    .map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.phone)}</td><td>${s.roles.map((r) => ROLE_LABEL[r]).join(", ")}</td><td>${s.active ? "Active" : "Inactive"}</td><td>${s.pinHash ? "Set" : `<span class="late">Not set</span>`}</td>${canEdit ? `<td><a href="/admin/staff?edit=${esc(s.id)}">Edit</a></td>` : ""}</tr>`)
    .join("");
  return layout(
    "Staff",
    `<h1>Staff</h1><table><tr><th>Name</th><th>Phone</th><th>Roles</th><th>Status</th><th>PIN</th>${canEdit ? "<th></th>" : ""}</tr>${rows}</table>${canEdit ? staffForm(editing) : ""}`,
    who,
    flash,
  );
}

export function staffForm(s?: Staff) {
  return `<div class="narrow"><h2 style="margin-top:20px">${s ? `Edit ${esc(s.name)}` : "Add a staff member"}</h2>
<form method="post" action="/admin/staff">${s ? `<input type="hidden" name="id" value="${esc(s.id)}">` : ""}
<label for="name">Name</label><input id="name" name="name" required value="${esc(s?.name)}">
<label for="phone">WhatsApp number</label><input id="phone" name="phone" required value="${esc(s?.phone)}">
<label>Roles</label>${ROLES.map((r) => `<label class="chk"><input type="checkbox" name="roles" value="${r}"${s?.roles.includes(r) ? " checked" : ""}>${ROLE_LABEL[r]}</label>`).join("")}
<label class="chk"><input type="checkbox" name="active" value="1"${!s || s.active ? " checked" : ""}>Active</label>
<label for="pin">${s?.pinHash ? "New PIN (leave empty to keep)" : "PIN (4 to 8 digits)"}</label><input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password">
<p><button class="primary">Save</button></p></form></div>`;
}

export function actorName(a: Actor) {
  return a.kind === "owner" ? "Owner" : a.staff.name;
}
