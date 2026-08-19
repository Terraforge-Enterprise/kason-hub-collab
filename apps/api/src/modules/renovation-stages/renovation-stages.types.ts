export type RenovationStageRow = {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
