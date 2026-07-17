export type UserRole = "admin" | "volunteer" | "patient";
export type QueueStatus = "waiting" | "seen";

export type Profile = {
  id: string;
  role: UserRole;
  full_name: string | null;
  phone: string | null;
  email: string | null;
};

export type Camp = {
  id: string;
  name: string;
  venue: string | null;
  camp_date: string | null;
  is_active: boolean;
  created_at: string;
};

export type Patient = {
  id: string;
  user_id: string | null;
  camp_id: string;
  reg_no: number;
  full_name: string;
  gender: "M" | "F" | "O" | null;
  age: number | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  aadhaar_last4: string | null;
  queue_status: QueueStatus;
  seen_at: string | null;
  created_by: string | null;
  created_at: string;
};
