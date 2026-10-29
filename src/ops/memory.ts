import staffSeed from "../../data/staff.json" with { type: "json" };
import type { OpsStore, OrderOps, RotaEntry, Role, Staff } from "./types.js";

export class MemoryOpsStore implements OpsStore {
  private staff = new Map<string, Staff>();
  private rota: RotaEntry[] = [];
  private orders = new Map<string, OrderOps>();
  /** "date|role" pairs the owner has set, even to nobody. Others fall back to the default rota. */
  private explicit = new Set<string>();
  private defaultRota: Partial<Record<Role, string[]>>;

  constructor(seed: { staff: Staff[]; defaultRota?: Partial<Record<Role, string[]>> } = staffSeed as { staff: Staff[] }) {
    for (const s of seed.staff) this.staff.set(s.id, structuredClone(s));
    this.defaultRota = structuredClone(seed.defaultRota ?? {});
  }

  async listStaff() {
    return structuredClone([...this.staff.values()]);
  }
  async getStaff(id: string) {
    const s = this.staff.get(id);
    return s && structuredClone(s);
  }
  async saveStaff(staff: Staff) {
    this.staff.set(staff.id, structuredClone(staff));
  }
  async listRota(fromDate: string, toDate: string) {
    const out = this.rota.filter((r) => r.date >= fromDate && r.date <= toDate);
    for (let d = fromDate; d <= toDate; d = nextDay(d)) {
      for (const [role, ids] of Object.entries(this.defaultRota) as [Role, string[]][]) {
        if (!this.explicit.has(`${d}|${role}`)) for (const staffId of ids) out.push({ date: d, role, staffId });
      }
    }
    return structuredClone(out);
  }
  async setRota(date: string, role: Role, staffIds: string[]) {
    this.explicit.add(`${date}|${role}`);
    this.rota = this.rota.filter((r) => !(r.date === date && r.role === role));
    for (const staffId of new Set(staffIds)) this.rota.push({ date, role, staffId });
  }
  async getOrderOps(reference: string) {
    const o = this.orders.get(reference);
    return o && structuredClone(o);
  }
  async listOrderOps() {
    return structuredClone([...this.orders.values()]);
  }
  async saveOrderOps(ops: OrderOps) {
    this.orders.set(ops.reference, structuredClone(ops));
  }
}

function nextDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
