import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DepositFields } from "../deposit-fields";

describe("<DepositFields>", () => {
  it("auto-displays computed rental deposit when rentalRate is set", () => {
    render(
      <DepositFields
        rentalRate={1000}
        depositMonths={2}
        utilitiesDepositMonths={0.5}
        accessCardDepositPerPcs={100}
        accessCardQuantity={2}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/RM2,000/i)).toBeInTheDocument();
    expect(screen.getByText(/RM500/i)).toBeInTheDocument();
    expect(screen.getByText(/RM200/i)).toBeInTheDocument();
  });

  it("hides computed rental deposit if rentalRate is missing", () => {
    render(
      <DepositFields
        rentalRate={null}
        depositMonths={2}
        utilitiesDepositMonths={null}
        accessCardDepositPerPcs={null}
        accessCardQuantity={null}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText(/RM/)).not.toBeInTheDocument();
  });

  it("emits onChange with new depositMonths value", () => {
    const onChange = vi.fn();
    render(
      <DepositFields
        rentalRate={1000}
        depositMonths={2}
        utilitiesDepositMonths={null}
        accessCardDepositPerPcs={null}
        accessCardQuantity={null}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(/rental deposit \(months\)/i);
    fireEvent.change(input, { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({ depositMonths: 3 });
  });

  it("emits onChange with accessCardQuantity", () => {
    const onChange = vi.fn();
    render(
      <DepositFields
        rentalRate={1000}
        depositMonths={2}
        utilitiesDepositMonths={null}
        accessCardDepositPerPcs={null}
        accessCardQuantity={null}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(/access card quantity/i);
    fireEvent.change(input, { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith({ accessCardQuantity: 2 });
  });

  it("placeholder uses 'e.g.' prefix so users don't mistake it for a default", () => {
    render(
      <DepositFields
        rentalRate={1000}
        depositMonths={null}
        utilitiesDepositMonths={null}
        accessCardDepositPerPcs={null}
        accessCardQuantity={null}
        onChange={() => {}}
      />,
    );
    const rentalInput = screen.getByLabelText(/rental deposit \(months\)/i);
    const utilitiesInput = screen.getByLabelText(/utilities deposit \(months\)/i);
    expect(rentalInput).toHaveAttribute("placeholder", "e.g. 2");
    expect(utilitiesInput).toHaveAttribute("placeholder", "e.g. 0.5");
  });

  describe("deposit basis — tenancy rent vs asking rate", () => {
    it("prices deposits off the TENANCY's rent when the unit is occupied", () => {
      // The reported case: unit advertised at RM1,500, let to a tenant at RM5.
      render(
        <DepositFields
          rentalRate={1500}
          tenancyMonthlyRent={5}
          depositMonths={2}
          utilitiesDepositMonths={0.5}
          accessCardDepositPerPcs={null}
          accessCardQuantity={null}
          onChange={() => {}}
        />,
      );
      expect(screen.getByText("RM10")).toBeInTheDocument();
      expect(screen.getByText("RM2.5")).toBeInTheDocument();
      // The asking-rate figures must be gone, not merely joined.
      expect(screen.queryByText(/RM3,000/)).not.toBeInTheDocument();
      expect(screen.queryByText(/RM750/)).not.toBeInTheDocument();
    });

    it("names the basis so the admin can tell which rent is in play", () => {
      render(
        <DepositFields
          rentalRate={1500}
          tenancyMonthlyRent={5}
          depositMonths={2}
          utilitiesDepositMonths={0.5}
          accessCardDepositPerPcs={null}
          accessCardQuantity={null}
          onChange={() => {}}
        />,
      );
      expect(screen.getByText(/this tenancy's rent of RM5\/month/i)).toBeInTheDocument();
    });

    it("keeps the asking rate when no tenancy rent is supplied (create / vacant)", () => {
      // Every create-flow caller omits the prop entirely — behaviour must be unchanged.
      render(
        <DepositFields
          rentalRate={1500}
          depositMonths={2}
          utilitiesDepositMonths={0.5}
          accessCardDepositPerPcs={null}
          accessCardQuantity={null}
          onChange={() => {}}
        />,
      );
      expect(screen.getByText("RM3,000")).toBeInTheDocument();
      expect(screen.getByText("RM750")).toBeInTheDocument();
      expect(screen.getByText(/the asking rate of RM1,500\/month/i)).toBeInTheDocument();
    });

    it("honours a ZERO tenancy rent instead of falling back to the asking rate", () => {
      render(
        <DepositFields
          rentalRate={1500}
          tenancyMonthlyRent={0}
          depositMonths={2}
          utilitiesDepositMonths={0.5}
          accessCardDepositPerPcs={null}
          accessCardQuantity={null}
          onChange={() => {}}
        />,
      );
      expect(screen.queryByText("RM3,000")).not.toBeInTheDocument();
      expect(screen.getAllByText("RM0").length).toBeGreaterThan(0);
    });
  });
});
