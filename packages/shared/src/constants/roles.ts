export const USER_ROLES = ["admin", "manager", "operator", "viewer", "accountant"] as const;
export const PARTY_ROLE_TYPES = ["owner", "tenant", "agent"] as const;
export const USER_TYPES = ["operator", "tenant", "agent"] as const;

/** userTypes allowed to access the admin panel — all others are portal-only */
export const ADMIN_USER_TYPES = ["operator"] as const;
