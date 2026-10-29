/** Kitchen operations after an order is paid: stages, staff, rota. Kept apart from checkout so each can change alone. */

export const ROLES = ["intake", "kitchen", "dispatch", "rider"] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = ["new", "accepted", "cooking", "ready", "out_for_delivery", "delivered", "picked_up", "cancelled"] as const;
export type Stage = (typeof STAGES)[number];

export const FINAL_STAGES: readonly Stage[] = ["delivered", "picked_up", "cancelled"];

export type Staff = {
  id: string;
  name: string;
  phone: string;
  roles: Role[];
  active: boolean;
  /** scrypt hash "salt:hash" of the staff PIN. No PIN = can't sign in to the portal yet. */
  pinHash?: string;
};

/** One person on one role for one day (Lagos date, YYYY-MM-DD). */
export type RotaEntry = { date: string; role: Role; staffId: string };

export type StageChange = { at: string; from: Stage; to: Stage; by: string; note?: string };

export type OrderOps = {
  reference: string;
  stage: Stage;
  cookId?: string;
  riderId?: string;
  history: StageChange[];
};

export interface OpsStore {
  listStaff(): Promise<Staff[]>;
  getStaff(id: string): Promise<Staff | undefined>;
  saveStaff(staff: Staff): Promise<void>;
  listRota(fromDate: string, toDate: string): Promise<RotaEntry[]>;
  /** Replace who is on `role` on `date`. */
  setRota(date: string, role: Role, staffIds: string[]): Promise<void>;
  getOrderOps(reference: string): Promise<OrderOps | undefined>;
  listOrderOps(): Promise<OrderOps[]>;
  saveOrderOps(ops: OrderOps): Promise<void>;
}
