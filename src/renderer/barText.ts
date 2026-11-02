// P3 (UX round 2): the floating bar's label for the call being recorded. Plain function, tested.
export function barChip(linked: boolean | null | undefined): { text: string; kind: "linked" | "local" } | null {
  if (linked === true) return { text: "Solace", kind: "linked" };
  if (linked === false) return { text: "Local only", kind: "local" };
  return null;
}
