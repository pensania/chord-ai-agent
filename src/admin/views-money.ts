import type { MenuItem } from "../domain.js";
import type { Staff } from "../ops/types.js";
import type { PayLine } from "../stock/kitchen.js";
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCategory, type Ingredient, type RecipeLine, type StockMove } from "../stock/types.js";
import { avatar, esc, icon, layout, naira, ROLE_LABEL, shortName } from "./views.js";

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  ingredients: "Ingredients",
  gas: "Cooking gas",
  packaging: "Packaging",
  transport: "Transport",
  rent: "Rent",
  utilities: "Power and water",
  equipment: "Equipment",
  other: "Other",
};

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n * 10 === Math.round(n * 10) ? 1 : 2));

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function monthNav(base: string, month: string) {
  return `<div class="weeknav"><a class="btn" href="${base}?month=${shiftMonth(month, -1)}">${icon("back", 15)}Previous</a><a class="btn ghost" href="${base}">This month</a><a class="btn" href="${base}?month=${shiftMonth(month, 1)}">Next${icon("fwd", 15)}</a></div>`;
}

const stat = (k: string, v: string | number, cls = "") => `<div class="panel stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;

/** Banner for the queue page when ingredients are running out. */
export function lowStockBanner(low: Ingredient[]) {
  if (!low.length) return "";
  const names = low.slice(0, 4).map((i) => `${esc(i.name)} (${qty(i.onHand)} ${esc(i.unit)})`).join(", ");
  return `<a class="flash" href="/admin/stock" style="text-decoration:none;color:inherit">${icon("alert", 16)}<span><b>Running low:</b> ${names}${low.length > 4 ? ` and ${low.length - 4} more` : ""}. Open Stock to restock.</span></a>`;
}

const level = (i: Ingredient) => {
  if (i.onHand <= 0) return `<span class="badge late">Out</span>`;
  if (i.onHand <= i.lowAt) return `<span class="badge today">Low</span>`;
  return `<span class="status"><i></i>OK</span>`;
};

export function stockPage(p: {
  ingredients: Ingredient[];
  menu: MenuItem[];
  recipes: Record<string, RecipeLine[]>;
  unitCosts: Record<string, number>;
  moves: StockMove[];
  canCount: boolean;
  isOwner: boolean;
  editing?: Ingredient;
  who: string;
  flash?: string;
}) {
  const byId = new Map(p.ingredients.map((i) => [i.id, i]));
  const low = p.ingredients.filter((i) => i.onHand <= i.lowAt).length;
  const value = p.ingredients.reduce((n, i) => n + Math.max(0, i.onHand) * i.costPerUnitNgn, 0);
  const rows = p.ingredients
    .map(
      (i) => `<tr><td><b>${esc(i.name)}</b></td><td class="num"><b>${qty(i.onHand)}</b> <span class="muted">${esc(i.unit)}</span></td><td>${level(i)}</td><td class="num muted">${qty(i.lowAt)} ${esc(i.unit)}</td><td class="num">${naira(i.costPerUnitNgn)}<span class="muted">/${esc(i.unit)}</span></td>
${p.canCount ? `<td><form method="post" action="/admin/stock/count" class="countform"><input type="hidden" name="id" value="${esc(i.id)}"><input name="counted" inputmode="decimal" aria-label="Counted ${esc(i.name)}" placeholder="${qty(i.onHand)}"><button>Save count</button></form></td>` : ""}
${p.isOwner ? `<td class="num"><a class="btn ghost" href="/admin/stock?edit=${esc(i.id)}">Edit</a></td>` : ""}</tr>`,
    )
    .join("");
  const recipeCards = p.menu
    .map((m) => {
      const lines = p.recipes[m.sku] ?? [];
      const cost = p.unitCosts[m.sku] ?? 0;
      const margin = m.priceNgn ? Math.round(((m.priceNgn - cost) / m.priceNgn) * 100) : 0;
      return `<article class="panel recipe"><div class="panel-h"><div><h2>${esc(m.name)}</h2><div class="muted">${naira(m.priceNgn)} · ingredients ${naira(cost)} · <b class="${margin < 40 ? "warn" : ""}">${margin}% margin</b></div></div>${p.isOwner ? `<a class="btn ghost" href="/admin/stock/recipe/${esc(m.sku)}">Edit</a>` : ""}</div>
<ul class="items" style="border:0;margin:0;padding:12px 18px">${lines.map((l) => `<li><b>${qty(l.qty)} ${esc(byId.get(l.ingredientId)?.unit ?? "")}</b><span>${esc(byId.get(l.ingredientId)?.name ?? l.ingredientId)}</span></li>`).join("") || `<li class="muted">No recipe yet, so cooking this won't change stock.</li>`}</ul></article>`;
    })
    .join("");
  const reason = { order: "Used for order", purchase: "Bought", adjust: "Counted" } as const;
  // One row per event: an order or a purchase moves several ingredients at once.
  const groups: StockMove[][] = [];
  for (const m of p.moves) {
    const last = groups.at(-1);
    if (last && m.ref && last[0].ref === m.ref && last[0].reason === m.reason && last[0].at === m.at) last.push(m);
    else groups.push([m]);
  }
  const moveRows = groups
    .slice(0, 12)
    .map((g) => {
      const m = g[0];
      const what = g.map((x) => `<span style="color:${x.delta < 0 ? "var(--danger)" : "var(--green)"}">${x.delta > 0 ? "+" : ""}${qty(x.delta)} ${esc(byId.get(x.ingredientId)?.unit ?? "")}</span> ${esc(byId.get(x.ingredientId)?.name ?? x.ingredientId)}`).join(" · ");
      const ref = m.ref ? ` <span class="ref">${m.ref.startsWith("MTK-") ? `<a href="/admin/orders/${esc(m.ref)}">${esc(m.ref)}</a>` : esc(m.ref)}</span>` : "";
      return `<tr><td class="muted nowrap">${esc(m.at.slice(0, 16).replace("T", " "))}</td><td class="nowrap">${reason[m.reason]}${ref}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ""}</td><td style="min-width:300px">${what}</td><td class="num nowrap">${naira(Math.abs(g.reduce((n, x) => n + x.costNgn, 0)))}</td><td class="muted">${esc(m.by)}</td></tr>`;
    })
    .join("");
  return layout(
    "Stock",
    `<div class="top"><div><p class="eyebrow">Kitchen</p><h1>Stock</h1><p class="sub">Ingredients come off automatically when an order starts cooking. Purchases on the Expenses page add them back.</p></div></div>
<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stat("Ingredients", p.ingredients.length)}${stat("Low or out", low, low ? "alert" : "")}${stat("Stock value", naira(Math.round(value)))}</div>
<div class="panel scroll" style="margin-bottom:22px"><table class="tbl"><thead><tr><th>Ingredient</th><th class="num">On hand</th><th>Level</th><th class="num">Warn at</th><th class="num">Cost</th>${p.canCount ? "<th>Physical count</th>" : ""}${p.isOwner ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div>
${p.isOwner ? ingredientForm(p.editing) : ""}
<h2 style="margin:26px 0 12px;font:600 20px/1.2 Fraunces,Georgia,serif">Recipes</h2>
<div class="recipes">${recipeCards}</div>
<h2 style="margin:26px 0 12px;font:600 20px/1.2 Fraunces,Georgia,serif">Recent movements</h2>
<div class="panel scroll"><table class="tbl"><thead><tr><th>When (UTC)</th><th>What happened</th><th>Ingredients</th><th class="num">Value</th><th>By</th></tr></thead><tbody>${moveRows || `<tr><td colspan="5" class="muted">Nothing yet.</td></tr>`}</tbody></table></div>`,
    p.who,
    p.flash,
  );
}

function ingredientForm(i?: Ingredient) {
  return `<section class="panel narrowpanel"><div class="panel-h"><h2>${i ? `Edit ${esc(i.name)}` : "Add an ingredient"}</h2>${i ? `<a class="muted" href="/admin/stock">Cancel</a>` : ""}</div>
<form method="post" action="/admin/stock/ingredient" class="panel-b form grid4">${i ? `<input type="hidden" name="id" value="${esc(i.id)}">` : ""}
<div><label class="lbl" for="iname">Name</label><input id="iname" name="name" required value="${esc(i?.name)}"></div>
<div><label class="lbl" for="iunit">Unit</label><input id="iunit" name="unit" required placeholder="kg, litre, piece" value="${esc(i?.unit)}"></div>
<div><label class="lbl" for="ilow">Warn at</label><input id="ilow" name="lowAt" inputmode="decimal" required value="${i ? qty(i.lowAt) : ""}"></div>
<div><label class="lbl" for="icost">Cost per unit (₦)</label><input id="icost" name="costPerUnitNgn" inputmode="numeric" required value="${i?.costPerUnitNgn ?? ""}"></div>
<div style="align-self:end"><button class="primary">Save</button></div></form></section>`;
}

export function recipePage(item: MenuItem, lines: RecipeLine[], ingredients: Ingredient[], who: string, flash?: string) {
  const amount = (id: string) => lines.find((l) => l.ingredientId === id)?.qty;
  const rows = ingredients
    .map((i) => `<tr><td>${esc(i.name)}</td><td><input name="qty:${esc(i.id)}" inputmode="decimal" value="${amount(i.id) !== undefined ? qty(amount(i.id)!) : ""}" placeholder="0" style="width:110px"> <span class="muted">${esc(i.unit)}</span></td><td class="num muted">${naira(i.costPerUnitNgn)}/${esc(i.unit)}</td></tr>`)
    .join("");
  return layout(
    `Recipe · ${item.name}`,
    `<a class="backlink" href="/admin/stock">${icon("back", 14)}Stock</a>
<div class="top"><div><p class="eyebrow">Recipe</p><h1>${esc(item.name)}</h1><p class="sub">How much of each ingredient one ${esc(item.name.toLowerCase())} uses. Leave a row empty if it isn't used.</p></div></div>
<form method="post" action="/admin/stock/recipe/${esc(item.sku)}" class="panel"><div class="scroll"><table class="tbl"><thead><tr><th>Ingredient</th><th>Amount per unit</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="savebar"><button class="primary">Save recipe</button></div></form>`,
    who,
    flash,
    "Recipe",
  );
}

export function expensesPage(p: {
  month: string;
  today: string;
  list: Expense[];
  total: number;
  byCategory: Record<ExpenseCategory, number>;
  ingredientsUsedNgn: number;
  ingredients: Ingredient[];
  who: string;
  flash?: string;
}) {
  const names = new Map(p.ingredients.map((i) => [i.id, i]));
  const rows = p.list
    .map(
      (e) => `<tr><td class="muted nowrap">${esc(e.date)}</td><td><b>${esc(e.description)}</b>${
        e.purchases ? `<div class="muted">${e.purchases.map((x) => `${qty(x.qty)} ${esc(names.get(x.ingredientId)?.unit ?? "")} ${esc(names.get(x.ingredientId)?.name ?? x.ingredientId)}`).join(" · ")}</div>` : ""
      }</td><td><span class="badge">${CATEGORY_LABEL[e.category]}</span></td><td class="num"><b>${naira(e.amountNgn)}</b></td><td class="muted">${esc(e.by)}</td></tr>`,
    )
    .join("");
  const top = (Object.entries(p.byCategory) as [ExpenseCategory, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const bars = top
    .map(([c, v]) => `<div class="bar"><span>${CATEGORY_LABEL[c]}</span><div><i style="width:${Math.max(4, Math.round((v / (top[0][1] || 1)) * 100))}%"></i></div><b>${naira(v)}</b></div>`)
    .join("");
  const ingOptions = `<option value="">Ingredient</option>${p.ingredients.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}`;
  const purchaseRow = (n: number) =>
    `<div class="prow"><select name="p${n}_id" aria-label="Ingredient ${n + 1}">${ingOptions}</select><input name="p${n}_qty" inputmode="decimal" placeholder="Qty" aria-label="Quantity ${n + 1}"><input name="p${n}_cost" inputmode="numeric" placeholder="Cost ₦" aria-label="Cost ${n + 1}"></div>`;
  return layout(
    "Expenses",
    `<div class="top"><div><p class="eyebrow">${esc(monthLabel(p.month))}</p><h1>Expenses</h1><p class="sub">Everything the kitchen spends. Ingredient purchases restock the Stock page and update the price.</p></div>${monthNav("/admin/expenses", p.month)}</div>
<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stat("Spent this month", naira(p.total))}${stat("Entries", p.list.length)}${stat("Ingredients used by orders", naira(p.ingredientsUsedNgn))}</div>
<div class="split">
<div class="stack">
${bars ? `<section class="panel"><div class="panel-h"><h2>By category</h2></div><div class="panel-b bars">${bars}</div></section>` : ""}
<div class="panel scroll"><table class="tbl"><thead><tr><th>Date</th><th>What</th><th>Category</th><th class="num">Amount</th><th>By</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">Nothing logged for ${esc(monthLabel(p.month))}.</td></tr>`}</tbody></table></div>
</div>
<section class="panel"><div class="panel-h"><h2>Log spending</h2></div>
<form method="post" action="/admin/expenses" class="panel-b form">
<div class="grid2"><div><label class="lbl" for="edate">Date</label><input id="edate" name="date" type="date" max="${esc(p.today)}" value="${esc(p.today)}"></div>
<div><label class="lbl" for="ecat">Category</label><select id="ecat" name="category" style="height:38px;width:100%">${EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${CATEGORY_LABEL[c]}</option>`).join("")}</select></div></div>
<div><label class="lbl" for="edesc">What for</label><input id="edesc" name="description" placeholder="Mile 12 market run"></div>
<div><label class="lbl" for="eamt">Amount (₦)</label><input id="eamt" name="amountNgn" inputmode="numeric" placeholder="Leave empty for an ingredient purchase"></div>
<div><span class="lbl" style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Ingredients bought (optional)</span>
<div class="prows">${[0, 1, 2, 3].map(purchaseRow).join("")}</div>
<p class="muted" style="margin:6px 0 0">If you list ingredients, the amount is their total cost and they're added to stock.</p></div>
<div><button class="primary">Save</button></div></form></section>
</div>`,
    p.who,
    p.flash,
  );
}

export function payPage(p: { month: string; lines: PayLine[]; total: number; who: string; flash?: string }) {
  const rows = p.lines
    .map(({ staff, rate, shifts, amountNgn }) => {
      const basis = rate?.basis ?? "none";
      return `<tr><td><span class="person">${avatar(staff, 30)}<span>${esc(shortName(staff.name))}<br><span class="muted">${staff.roles.map((r) => ROLE_LABEL[r]).join(", ")}</span></span></span></td>
<td><form method="post" action="/admin/pay" class="rateform"><input type="hidden" name="staffId" value="${esc(staff.id)}"><input type="hidden" name="month" value="${esc(p.month)}">
<select name="basis" aria-label="Pay basis for ${esc(staff.name)}"><option value="per_shift"${basis === "per_shift" ? " selected" : ""}>Per shift</option><option value="monthly"${basis === "monthly" ? " selected" : ""}>Monthly</option><option value="none"${basis === "none" ? " selected" : ""}>Not paid here</option></select>
<input name="amountNgn" inputmode="numeric" value="${rate?.amountNgn ?? ""}" placeholder="₦" aria-label="Amount for ${esc(staff.name)}"><button>Save</button></form></td>
<td class="num">${rate?.basis === "per_shift" ? shifts : "—"}</td><td class="num"><b>${amountNgn ? naira(amountNgn) : `<span class="muted">—</span>`}</b></td></tr>`;
    })
    .join("");
  const paid = p.lines.filter((l) => l.amountNgn > 0).length;
  return layout(
    "Pay",
    `<div class="top"><div><p class="eyebrow">${esc(monthLabel(p.month))}</p><h1>Staff pay</h1><p class="sub">Per-shift pay counts each day someone is on the rota, whatever their role. Change the rota and this updates.</p></div>${monthNav("/admin/pay", p.month)}</div>
<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stat("Payroll for the month", naira(p.total))}${stat("People paid", paid)}${stat("Average", paid ? naira(Math.round(p.total / paid)) : "—")}</div>
<div class="panel scroll"><table class="tbl"><thead><tr><th>Person</th><th>Rate</th><th class="num">Shifts</th><th class="num">Owed</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    p.who,
    p.flash,
  );
}

export type { Staff };
