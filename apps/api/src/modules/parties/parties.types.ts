export type PartiesSession = {
  userId: string;
  orgId: string;
  role: string;
};

export type HierarchyNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  status: string;
  uplineId: string | null;
  directDownlineCount: number;
  // 'agent' for sales-team nodes; 'individual' for staff users (admins /
  // managers / editors) who appear in the tree because they are the upline
  // of at least one agent. The tree visual treats staff distinctly. Optional
  // because pre-existing tests stub HierarchyNode rows without it.
  partyType?: string;
  // For partyType='individual' only — the linked User.role (admin / manager /
  // editor / viewer) so the chart can render distinct colors and labels per
  // role. Null for agents and for individual parties without a User link.
  userRole?: string | null;
};
