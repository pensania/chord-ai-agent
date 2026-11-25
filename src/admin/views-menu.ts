import type { DeliveryZone, MenuItem } from "../domain.js";
import { esc, layout, naira } from "./views.js";

const itemUrl = (sku: string) => `/admin/menu/${encodeURIComponent(sku)}`;

export function menuPage(menu: MenuItem[], who: string, flash?: string) {
  const rows = menu
    .map((m, n) => {
      const form = `item${n}`; // the fields sit in different cells, so they name their form
      return `<tr><td class="ref nowrap">${esc(m.sku)}</td>
<td><input form="${form}" name="name" required maxlength="80" value="${esc(m.name)}" aria-label="Name of ${esc(m.sku)}" style="min-width:220px"></td>
<td><input form="${form}" name="priceNgn" required inputmode="numeric" value="${m.priceNgn}" aria-label="Price of ${esc(m.name)}" style="width:100px"></td>
<td><label class="nowrap"><input form="${form}" type="checkbox" name="active" value="1"${m.active ? " checked" : ""}> On the menu</label></td>
<td><form id="${form}" method="post" action="${esc(itemUrl(m.sku))}"><button>Save</button></form></td>
<td><form method="post" action="${esc(itemUrl(m.sku))}/stock" class="countform"><input type="hidden" name="was" value="${m.stock}"><input name="stock" required inputmode="numeric" value="${m.stock}" aria-label="Stock of ${esc(m.name)}"><button>Set stock</button></form>${m.stock <= 0 ? `<span class="badge late">Sold out</span>` : ""}</td></tr>`;
    })
    .join("");
  return layout(
    "Menu",
    `<div class="top"><div><p class="eyebrow">Selling</p><h1>Menu</h1><p class="sub">What the assistant offers on WhatsApp. Changes apply to the next message. Orders already made keep their price.</p></div></div>
<div class="panel scroll" style="margin-bottom:22px"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Price (₦)</th><th></th><th></th><th>For sale</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">Nothing on the menu yet.</td></tr>`}</tbody></table></div>
<section class="panel narrowpanel"><div class="panel-h"><h2>Add an item</h2></div>
<form method="post" action="/admin/menu" class="panel-b form grid4">
<div><label class="lbl" for="msku">Code</label><input id="msku" name="sku" required maxlength="24" placeholder="JOL-MEDIUM"></div>
<div><label class="lbl" for="mname">Name</label><input id="mname" name="name" required maxlength="80"></div>
<div><label class="lbl" for="mprice">Price (₦)</label><input id="mprice" name="priceNgn" required inputmode="numeric"></div>
<div><label class="lbl" for="mstock">For sale</label><input id="mstock" name="stock" required inputmode="numeric" value="0"></div>
<div style="align-self:end"><input type="hidden" name="active" value="1"><button class="primary">Add</button></div></form></section>`,
    who,
    flash,
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
