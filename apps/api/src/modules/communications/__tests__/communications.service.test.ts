import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationService, enqueueNotificationService } from "../communications.service";
import * as repo from "../communications.repository";

vi.mock("../communications.repository", () => ({
  listNotifications: vi.fn(),
  listNotificationQueue: vi.fn(),
  createNotification: vi.fn(),
  enqueueNotification: vi.fn(),
}));

const mockedRepo = vi.mocked(repo);
const session = { userId: "u1", orgId: "o1", role: "admin" };

describe("communications.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates in-app notification", async () => {
    mockedRepo.createNotification.mockResolvedValueOnce({ id: "n1" } as never);

    const res = await createNotificationService(session, {
      userId: "",
      domain: "billing",
      title: "Charge posted",
      body: "Charge CHG-001 posted",
      actionUrl: "/billing/charges",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(201);
  });

  it("enqueues outbound notification", async () => {
    mockedRepo.enqueueNotification.mockResolvedValueOnce({ id: "q1" } as never);

    const res = await enqueueNotificationService(session, {
      type: "general",
      recipientEmail: "ops@example.com",
      recipientName: "Ops",
      subject: "Hello",
      body: "Queue me",
      channel: "email",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(201);
  });
});
