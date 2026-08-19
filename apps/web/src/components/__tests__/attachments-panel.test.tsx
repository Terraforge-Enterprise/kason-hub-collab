import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AttachmentUrl } from "@/api/tasks";
import { AttachmentsPanel } from "../attachments-panel";

// Minimal upload-hook stub — the panel only reads `.items` and `.enqueue` here.
const upload = {
  items: [],
  enqueue: vi.fn(),
  retry: vi.fn(),
} as unknown as Parameters<typeof AttachmentsPanel>[0]["upload"];

function renderPanel(entries: AttachmentUrl[]) {
  return render(
    <AttachmentsPanel
      entries={entries}
      fallbackKeys={entries.map((e) => e.key)}
      upload={upload}
      onRemove={vi.fn()}
      readOnly
      noun="task"
    />,
  );
}

describe("AttachmentsPanel media viewer", () => {
  it("opens a video in an inline <video> lightbox instead of a new tab", () => {
    renderPanel([
      { key: "v1", url: "https://x/v1.mp4", kind: "video", thumbnail: null } as AttachmentUrl,
    ]);
    // The tile is a button (opens the lightbox), NOT an <a target="_blank">.
    const tile = screen.getByRole("button", { name: /view video/i });
    expect(tile.tagName).toBe("BUTTON");
    fireEvent.click(tile);

    const dialog = screen.getByRole("dialog", { name: /viewer/i });
    const video = dialog.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video?.getAttribute("src")).toBe("https://x/v1.mp4");
  });

  it("renders a photo tile as a button that opens the image lightbox", () => {
    renderPanel([
      { key: "p1", url: "https://x/p1.jpg", kind: "image", thumbnail: null } as AttachmentUrl,
    ]);
    fireEvent.click(screen.getByRole("button", { name: /view image/i }));
    const dialog = screen.getByRole("dialog", { name: /viewer/i });
    expect(dialog.querySelector("img")).not.toBeNull();
  });
});
