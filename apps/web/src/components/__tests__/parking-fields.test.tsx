import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParkingFields } from "../parking-fields";

describe("<ParkingFields>", () => {
  it("renders no spot inputs when quantity is 0 or null", () => {
    const { rerender } = render(
      <ParkingFields parkingQuantity={null} parkingNumbers={[]} onChange={() => {}} />,
    );
    expect(screen.queryByLabelText(/spot/i)).not.toBeInTheDocument();
    rerender(<ParkingFields parkingQuantity={0} parkingNumbers={[]} onChange={() => {}} />);
    expect(screen.queryByLabelText(/spot/i)).not.toBeInTheDocument();
  });

  it("renders N spot inputs when quantity is N", () => {
    render(
      <ParkingFields
        parkingQuantity={3}
        parkingNumbers={["B2-145", "B3-088", ""]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/spot 1/i)).toHaveValue("B2-145");
    expect(screen.getByLabelText(/spot 2/i)).toHaveValue("B3-088");
    expect(screen.getByLabelText(/spot 3/i)).toHaveValue("");
  });

  it("emits onChange with resized array when quantity changes", () => {
    const onChange = vi.fn();
    render(
      <ParkingFields
        parkingQuantity={2}
        parkingNumbers={["B2-145", "B3-088"]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/parking quantity/i), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith({
      parkingQuantity: 3,
      parkingNumbers: ["B2-145", "B3-088", ""],
    });
  });

  it("emits onChange when a spot input changes", () => {
    const onChange = vi.fn();
    render(
      <ParkingFields
        parkingQuantity={2}
        parkingNumbers={["B2-145", "B3-088"]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/spot 1/i), { target: { value: "B2-200" } });
    expect(onChange).toHaveBeenCalledWith({
      parkingQuantity: 2,
      parkingNumbers: ["B2-200", "B3-088"],
    });
  });
});
