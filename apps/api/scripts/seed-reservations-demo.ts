import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { db as prisma } from "@kason/db";
import sharp from "sharp";
import { getTemplateForOrgDocType } from "../src/lib/document-templates/service";
import { renderToHtml } from "../src/lib/document-templates/render";
import { htmlToPdf, closeBrowser } from "../src/lib/document-templates/pdf";
import { putObject } from "../src/lib/storage";
import { buildReservationBodyHtml } from "../src/modules/reservations/render-body";

const ORG_ID = "a5466f04-0d65-4c5e-a73e-da0b64337bd5";
const ISSUER_PARTY_ID = "33b9b0df-ae08-4f2b-a5fd-69a2cad0553d";

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

type Row = {
  refCode: string;
  status: "pending_customer" | "signed" | "cancelled" | "expired";
  unitId: string;
  propertyId: string;
  expiresAt: Date;
  applicantFullName: string;
  applicantNric: string;
  applicantContact: string;
  applicantEmail: string;
  signedAt?: Date;
  signatureTypedName?: string;
  cancelledAt?: Date;
  cancelReason?: string;
};

const ROWS: Row[] = [
  {
    refCode: "RSV-2026-0001",
    status: "pending_customer",
    unitId: "1e340f37-7c97-470c-b3b6-8c5f317f34a1",
    propertyId: "79c3a631-f120-498e-80c9-4b28a7365654",
    expiresAt: days(5),
    applicantFullName: "Lee Chee Hong",
    applicantNric: "900101-14-1234",
    applicantContact: "+60123456789",
    applicantEmail: "chee.hong.demo@example.com",
  },
  {
    refCode: "RSV-2026-0002",
    status: "pending_customer",
    unitId: "623c3929-d477-48f1-aff1-67965b06999f",
    propertyId: "4a9dfcc7-1760-4b5c-a076-c9d40706d511",
    expiresAt: days(2),
    applicantFullName: "Siti Nurhaliza binti Yusof",
    applicantNric: "920215-08-2345",
    applicantContact: "+60198765432",
    applicantEmail: "siti.demo@example.com",
  },
  {
    refCode: "RSV-2026-0003",
    status: "signed",
    unitId: "ecb548fa-b1ea-4332-b909-10cd14fa285f",
    propertyId: "6ebec518-e17e-40ac-a9d7-4de4f039c8eb",
    expiresAt: days(10),
    applicantFullName: "Rajesh Kumar a/l Suppiah",
    applicantNric: "850430-10-3456",
    applicantContact: "+60112223344",
    applicantEmail: "rajesh.demo@example.com",
    signedAt: days(-1),
    signatureTypedName: "Rajesh Kumar a/l Suppiah",
  },
  {
    refCode: "RSV-2026-0004",
    status: "cancelled",
    unitId: "6271ce66-065b-4ce8-b76d-82191e934f3f",
    propertyId: "6ebec518-e17e-40ac-a9d7-4de4f039c8eb",
    expiresAt: days(7),
    applicantFullName: "Tan Mei Chen",
    applicantNric: "880611-07-4567",
    applicantContact: "+60132345678",
    applicantEmail: "mei.chen.demo@example.com",
    cancelledAt: days(-2),
    cancelReason: "Applicant withdrew before signing",
  },
  {
    refCode: "RSV-2026-0005",
    status: "expired",
    unitId: "21989db9-0ef0-4e09-86ab-d035796080c4",
    propertyId: "6ebec518-e17e-40ac-a9d7-4de4f039c8eb",
    expiresAt: days(-3),
    applicantFullName: "Wong Kah Wai",
    applicantNric: "870923-14-5678",
    applicantContact: "+60145678901",
    applicantEmail: "kah.wai.demo@example.com",
  },
];

// Puppeteer needs a Chromium binary. On macOS dev machines fall back to
// Chrome.app so seeding works without the operator setting an env var.
function ensurePuppeteerExecutable(): void {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return;
  if (process.platform === "darwin") {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(macChrome)) {
      process.env.PUPPETEER_EXECUTABLE_PATH = macChrome;
      return;
    }
  }
  throw new Error(
    "PUPPETEER_EXECUTABLE_PATH not set and no Chrome/Chromium auto-detected. " +
      "Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH to your Chromium binary.",
  );
}

async function buildSignaturePng(typedName: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90">
    <rect width="100%" height="100%" fill="white"/>
    <text x="20" y="60" font-family="Brush Script MT, cursive, serif" font-size="42" font-style="italic" fill="#1a3a5c">${typedName}</text>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function generateSignedArtifacts(row: Row, reservationId: string): Promise<void> {
  if (row.status !== "signed" || !row.signedAt || !row.signatureTypedName) return;

  const property = await prisma.property.findUniqueOrThrow({
    where: { id: row.propertyId },
    select: { name: true },
  });
  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: row.unitId },
    select: { unitCode: true },
  });

  const template = await getTemplateForOrgDocType(ORG_ID, "reservation_form");
  const bodyHtml = buildReservationBodyHtml({
    applicant: {
      fullName: row.applicantFullName,
      nric: row.applicantNric,
      contact: row.applicantContact,
      email: row.applicantEmail,
    },
    property: {
      name: property.name,
      unitCode: unit.unitCode,
      carPark: null,
    },
    schedule: {
      moveIn: days(14),
      moveOut: days(14 + 365),
      remarks: null,
    },
    section1: { reservationDeposit: "500", documentationFee: "200" },
    section2: { rentalDeposit: "4400", utilityDeposit: "600", accessCardDeposit: "100" },
  });

  const pngBuffer = await buildSignaturePng(row.signatureTypedName);
  const pngDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

  const html = renderToHtml({
    template,
    referenceCode: row.refCode,
    issuedDate: days(-1),
    dueDate: row.expiresAt,
    bodyHtml,
    signature: {
      pngDataUrl,
      typedName: row.signatureTypedName,
      signedAt: row.signedAt,
      ip: "127.0.0.1",
    },
  });
  const pdfBuffer = await htmlToPdf(html);

  const sigKey = `reservations/${reservationId}/signature.png`;
  const pdfKey = `reservations/${reservationId}/signed.pdf`;
  await putObject(sigKey, pngBuffer, "image/png");
  await putObject(pdfKey, pdfBuffer, "application/pdf");

  await prisma.unitReservation.update({
    where: { id: reservationId },
    data: {
      signatureDrawingKey: sigKey,
      signedPdfKey: pdfKey,
      signedFromIp: "127.0.0.1",
      signedUserAgent: "demo-seed",
    },
  });
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not point at localhost. Got: ${url.replace(/:[^@]+@/, ":***@")}`,
    );
  }

  ensurePuppeteerExecutable();

  // Idempotent: remove prior demo rows by their stable reference codes.
  const refCodes = ROWS.map((r) => r.refCode);
  const existing = await prisma.unitReservation.findMany({
    where: { organizationId: ORG_ID, referenceCode: { in: refCodes } },
    select: { id: true },
  });
  if (existing.length > 0) {
    await prisma.unitReservationTransition.deleteMany({
      where: { reservationId: { in: existing.map((r) => r.id) } },
    });
    await prisma.unitReservation.deleteMany({
      where: { id: { in: existing.map((r) => r.id) } },
    });
    console.log(`Removed ${existing.length} prior demo reservation(s).`);
  }

  for (const row of ROWS) {
    const reservation = await prisma.unitReservation.create({
      data: {
        organizationId: ORG_ID,
        referenceCode: row.refCode,
        status: row.status,
        issuedByPartyId: ISSUER_PARTY_ID,
        issuedAt: days(-1),
        expiresAt: row.expiresAt,
        publicToken: randomBytes(16).toString("base64url"),
        propertyId: row.propertyId,
        unitId: row.unitId,
        proposedMoveIn: days(14),
        proposedMoveOut: days(14 + 365),
        reservationDeposit: 500,
        documentationFee: 200,
        rentalDeposit: 4400,
        utilityDeposit: 600,
        accessCardDeposit: 100,
        applicantFullName: row.applicantFullName,
        applicantNric: row.applicantNric,
        applicantContact: row.applicantContact,
        applicantEmail: row.applicantEmail,
        signedAt: row.signedAt,
        signatureTypedName: row.signatureTypedName,
        signatureAgreementTickedAt: row.signedAt,
        cancelledAt: row.cancelledAt,
        cancelReason: row.cancelReason,
      },
    });

    await generateSignedArtifacts(row, reservation.id);

    const transitions: { toStatus: string; changedAt: Date; note?: string }[] = [
      { toStatus: "pending_customer", changedAt: days(-1), note: "issued by agent" },
    ];
    if (row.status === "signed" && row.signedAt) {
      transitions.push({ toStatus: "signed", changedAt: row.signedAt, note: "applicant signed" });
    }
    if (row.status === "cancelled" && row.cancelledAt) {
      transitions.push({
        toStatus: "cancelled",
        changedAt: row.cancelledAt,
        note: row.cancelReason,
      });
    }
    if (row.status === "expired") {
      transitions.push({
        toStatus: "expired",
        changedAt: row.expiresAt,
        note: "auto-expired by sweeper",
      });
    }

    let previous: string | null = null;
    for (const t of transitions) {
      await prisma.unitReservationTransition.create({
        data: {
          organizationId: ORG_ID,
          reservationId: reservation.id,
          fromStatus: previous,
          toStatus: t.toStatus,
          actor: "demo-seed",
          changedAt: t.changedAt,
          note: t.note,
        },
      });
      previous = t.toStatus;
    }

    console.log(`  ${row.refCode}  ${row.status.padEnd(18)}  ${row.applicantFullName}`);
  }

  console.log(`\nInserted ${ROWS.length} demo reservations.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
    await prisma.$disconnect();
  });
