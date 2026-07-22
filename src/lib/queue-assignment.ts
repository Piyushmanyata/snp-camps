type AssignmentOutcome = {
  already_seen: boolean;
  doctor_id: string | null;
  error_code: string | null;
  queue_status: string;
};

export function isSuccessfulAssignment(row: AssignmentOutcome) {
  return (
    row.error_code === null &&
    !row.already_seen &&
    row.queue_status === "seen" &&
    Boolean(row.doctor_id)
  );
}
