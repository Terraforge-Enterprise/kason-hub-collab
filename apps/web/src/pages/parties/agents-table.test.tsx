import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { AgentTable, type AgentListItem } from "./agents-table";

const noop = () => {};

const sample: AgentListItem = {
  id: "1",
  displayName: "Farah",
  legalName: null,
  primaryEmail: null,
  primaryPhone: null,
  formattedPhone: null,
  nationality: "MY",
  agentLevel: "leader",
  status: "active",
  isBlacklisted: false,
  updatedAt: "",
  createdAt: "",
  bankName: null,
  bankAccountHolder: null,
  bankAccountNumber: null,
  idType: null,
  idNumber: null,
  portalUser: null,
  photoUrl: null,
};

describe("AgentTable", () => {
  test("renders agent row with nationality label resolved", () => {
    render(
      <AgentTable
        agents={[sample]}
        onEdit={noop}
        onBlacklist={noop}
        onReactivate={noop}
        onDeactivate={noop}
        onActivate={noop}
        onGrantPortal={noop}
        onRevokePortal={noop}
        onResetPortalPassword={noop}
        onViewDetails={noop}
      />
    );
    expect(screen.getByText("Farah")).toBeInTheDocument();
    expect(screen.getByText("Malaysian")).toBeInTheDocument();
  });
});
