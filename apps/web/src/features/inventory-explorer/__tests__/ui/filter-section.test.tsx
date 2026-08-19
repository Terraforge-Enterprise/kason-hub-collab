import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterSection } from "../../ui/filter-section";

describe("FilterSection", () => {
  it("when always-open=true, body is visible and no chevron", () => {
    render(<FilterSection title="Bedrooms" alwaysOpen activeCount={0}><div>BODY</div></FilterSection>);
    expect(screen.getByText("BODY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bedrooms/i })).not.toBeInTheDocument();
  });

  it("when collapsible and defaultOpen=false, body is hidden", () => {
    render(<FilterSection title="Floor area" defaultOpen={false} activeCount={0}><div>BODY</div></FilterSection>);
    expect(screen.queryByText("BODY")).not.toBeInTheDocument();
  });

  it("clicking the title toggles open/closed", async () => {
    render(<FilterSection title="City" defaultOpen={false} activeCount={0}><div>BODY</div></FilterSection>);
    await userEvent.click(screen.getByRole("button", { name: /City/i }));
    expect(screen.getByText("BODY")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /City/i }));
    expect(screen.queryByText("BODY")).not.toBeInTheDocument();
  });

  it("activeCount > 0 renders a count badge", () => {
    render(<FilterSection title="City" defaultOpen activeCount={3}><div>BODY</div></FilterSection>);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hidden=true renders nothing", () => {
    render(<FilterSection title="X" alwaysOpen hidden activeCount={0}><div>BODY</div></FilterSection>);
    expect(screen.queryByText("BODY")).not.toBeInTheDocument();
    expect(screen.queryByText("X")).not.toBeInTheDocument();
  });
});
