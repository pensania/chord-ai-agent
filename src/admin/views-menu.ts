import type { DeliveryZone, MenuItem } from "../domain.js";
import { addDays } from "../ops/operations.js";
import type { DayLine } from "../stock/catalogue.js";
import { esc, icon, layout, naira } from "./views.js";

const itemUrl = (sku: string) => `/admin/menu/${encodeURIComponent(sku)}`;

export function menuPage(menu: MenuItem[], who: string, flash?: string) {
  const rows = menu
    .map((m, n) => {
      const form = `item${n}`; // the fields sit in different cells, so they name their form
      return `<tr><td class="ref nowrap">${esc(m.sku)}</td>
<td><input form="${form}" name="name" required maxlength="80" value="${esc(m.name)}" aria-label="Name of ${esc(m.sku)}" style="min-width:220px"></td>
<td><input form="${form}" name="priceNgn" required inputmode="numeric" value="${m.priceNgn}" aria-label="Price of ${esc(m.name)}" style="width:100px"></td>
<td><label class="nowrap"><input form="${form}" type="checkbox" name="active" value="1"${m.active ? " checked" : ""}> On the menu</label></td>
<td><input form="${form}" name="stock" required inputmode="numeric" value="${m.stock}" aria-label="${esc(m.name)} per day" style="width:80px"></td>
<td><form id="${form}" method="post" action="${esc(itemUrl(m.sku))}"><button>Save</button></form></td></tr>`;
    })
    .join("");
  return layout(
    "Menu",
    `<div class="top"><div><p class="eyebrow">Selling</p><h1>Menu</h1><p class="sub">What the assistant offers on WhatsApp. Changes apply to the next message. Orders already made keep their price. <b>Per day</b> is how many the kitchen can make for one delivery day; set a different number for one day on <a href="/admin/capacity">Daily capacity</a>.</p></div></div>
<div class="panel scroll" style="margin-bottom:22px"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Price (₦)</th><th></th><th>Per day</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">Nothing on the menu yet.</td></tr>`}</tbody></table></div>
<section class="panel narrowpanel"><div class="panel-h"><h2>Add an item</h2></div>
<form method="post" action="/admin/menu" class="panel-b form grid4">
<div><label class="lbl" for="msku">Code</label><input id="msku" name="sku" required maxlength="24" placeholder="JOL-MEDIUM"></div>
<div><label class="lbl" for="mname">Name</label><input id="mname" name="name" required maxlength="80"></div>
<div><label class="lbl" for="mprice">Price (₦)</label><input id="mprice" name="priceNgn" required inputmode="numeric"></div>
<div><label class="lbl" for="mstock">Per day</label><input id="mstock" name="stock" required inputmode="numeric" value="0"></div>
<div style="align-self:end"><input type="hidden" name="active" value="1"><button class="primary">Add</button></div></form></section>`,
    who,
    flash,
  );
}

export function capacityPage(date: string, lines: DayLine[], who: string, flash?: string) {
  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const rows = lines
    .map(
      ({ item, own, sold, left }) => `<tr><td><b>${esc(item.name)}</b>${item.active ? "" : ` <span class="muted">hidden</span>`}</td><td class="num">${item.stock}</td>
<td><input name="n:${esc(item.sku)}" inputmode="numeric" value="${own ?? ""}" placeholder="${item.stock}" aria-label="${esc(item.name)} on this day" style="width:90px"></td><td class="num">${sold}</td><td class="num">${left > 0 ? `<b>${left}</b>` : `<span class="badge late">Full</span>`}</td></tr>`,
    )
    .join("");
  const nav = (d: string) => `/admin/capacity?date=${d}`;
  return layout(
    "Daily capacity",
    `<div class="top"><div><p class="eyebrow">${esc(label)}</p><h1>Daily capacity</h1><p class="sub">How many of each item can be sold for this delivery day. Leave a box empty to use the usual number; 0 takes no more orders.</p></div>
<div class="weeknav"><a class="btn" href="${nav(addDays(date, -1))}">${icon("back", 15)}Day before</a><a class="btn ghost" href="/admin/capacity">Tomorrow</a><a class="btn" href="${nav(addDays(date, 1))}">Day after${icon("fwd", 15)}</a></div></div>
<form method="get" action="/admin/capacity" class="countform" style="margin-bottom:14px"><input type="date" name="date" value="${esc(date)}" aria-label="Delivery day" style="width:170px"><button>Show day</button></form>
<form method="post" action="/admin/capacity" class="panel"><input type="hidden" name="date" value="${esc(date)}"><div class="scroll"><table class="tbl"><thead><tr><th>Item</th><th class="num">Usual</th><th>This day</th><th class="num">Sold</th><th class="num">Left</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="savebar"><span class="muted" style="margin-right:auto;align-self:center">Going below what's already sold doesn't cancel anything.</span><button class="primary">Save this day</button></div></form>`,
    who,
    flash,
    "Capacity",
  );
}

export function zonesPage(zones: DeliveryZone[], who: string, flash?: string) {
  const rows = zones
    .map((z) => {
      const pickup = z.zone.toLowerCase() === "pickup";
      return `<tr><td><b>${esc(z.zone)}</b></td><td>${
        pickup
          ? `<span class="muted">${naira(0)}, always free</span>`
          : `<form method="post" action="/admin/zones" class="countform"><input type="hidden" name="zone" value="${esc(z.zone)}"><input name="feeNgn" required inputmode="numeric" value="${z.feeNgn}" aria-label="Fee for ${esc(z.zone)}"><button>Save fee</button></form>`
      }</td><td class="num">${pickup ? "" : `<form method="post" action="/admin/zones/remove"><input type="hidden" name="zone" value="${esc(z.zone)}"><button>Remove</button></form>`}</td></tr>`;
    })
    .join("");
  return layout(
    "Delivery zones",
    `<div class="top"><div><p class="eyebrow">Selling</p><h1>Delivery zones</h1><p class="sub">Where you deliver and what it costs. Orders already made keep their fee.</p></div></div>
<div class="panel scroll" style="margin-bottom:22px"><table class="tbl"><thead><tr><th>Zone</th><th>Fee (₦)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<section class="panel narrowpanel"><div class="panel-h"><h2>Add a zone</h2></div>
<form method="post" action="/admin/zones" class="panel-b form grid4">
<div><label class="lbl" for="zname">Zone</label><input id="zname" name="zone" required maxlength="60" placeholder="Maryland"></div>
<div><label class="lbl" for="zfee">Fee (₦)</label><input id="zfee" name="feeNgn" required inputmode="numeric"></div>
<div style="align-self:end"><button class="primary">Add</button></div></form></section>`,
    who,
    flash,
    "Zones",
  );
}
