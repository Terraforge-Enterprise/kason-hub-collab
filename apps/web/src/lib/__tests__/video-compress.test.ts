import { describe, it, expect, vi, beforeEach } from "vitest";

// In-test mock for @ffmpeg/ffmpeg + @ffmpeg/util. The compressVideoIfOversize
// helper imports both via dynamic import; vi.mock with a factory replaces
// the modules everywhere they're imported (including dynamic import) for
// the lifetime of this file's tests.
//
// We capture the args passed to ffmpeg.exec so tests can assert that the
// expected H.264 / AAC pipeline was used.

// Typed mocks — keep arg types explicit so .mock.calls[0][0] is well-typed
// and the dynamic-import shape matches the real ffmpeg.wasm API.
const execMock = vi.fn<(args: string[]) => Promise<number>>(async () => 0);
const writeFileMock = vi.fn<(name: string, data: Uint8Array) => Promise<void>>(async () => undefined);
const readFileMock = vi.fn<(name: string) => Promise<Uint8Array>>(async () => new Uint8Array(8));
const loadMock = vi.fn<() => Promise<void>>(async () => undefined);
const onMock = vi.fn<(event: string, cb: (e: { progress: number }) => void) => void>();

class FakeFFmpeg {
  on = onMock;
  load = loadMock;
  writeFile = writeFileMock;
  exec = execMock;
  readFile = readFileMock;
}

vi.mock("@ffmpeg/ffmpeg", () => ({ FFmpeg: FakeFFmpeg }));
vi.mock("@ffmpeg/util", () => ({
  fetchFile: vi.fn(async (file: File) =>
    new Uint8Array(await file.arrayBuffer()),
  ),
}));

// Lazy import AFTER vi.mock is set up; otherwise the real module is captured.
async function loadHelper() {
  return import("../video-compress");
}

function makeFile(name: string, sizeBytes: number, type: string): File {
  const blob = new Blob([new Uint8Array(0)], { type });
  const file = new File([blob], name, { type });
  Object.defineProperty(file, "size", { value: sizeBytes, configurable: true });
  return file;
}

describe("compressVideoIfOversize", () => {
  beforeEach(() => {
    execMock.mockClear();
    writeFileMock.mockClear();
    readFileMock.mockClear();
    loadMock.mockClear();
    onMock.mockClear();
    readFileMock.mockResolvedValue(new Uint8Array(8));
  });

  it("returns the original file untouched when below the cap", async () => {
    const { compressVideoIfOversize } = await loadHelper();
    const small = makeFile("ok.mp4", 10 * 1024 * 1024, "video/mp4");
    const result = await compressVideoIfOversize(small, 250 * 1024 * 1024);
    if ("output" in result) {
      expect(result.compressed).toBe(false);
      expect(result.output).toBe(small);
    } else {
      throw new Error("expected output result");
    }
    expect(execMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("invokes ffmpeg with H.264 / AAC args when over the cap", async () => {
    const { compressVideoIfOversize } = await loadHelper();
    const big = makeFile("walkthrough.mp4", 300 * 1024 * 1024, "video/mp4");
    const result = await compressVideoIfOversize(big, 250 * 1024 * 1024);
    expect("output" in result).toBe(true);
    if ("output" in result) {
      expect(result.compressed).toBe(true);
      expect(result.output.type).toBe("video/mp4");
      expect(result.output.name).toBe("walkthrough.mp4");
    }
    expect(loadMock).toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(1);
    const args = execMock.mock.calls[0][0] as string[];
    // Spot-check the pipeline contract.
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("-movflags");
    expect(args).toContain("+faststart");
    expect(args).toContain("-b:v");
    expect(args).toContain("6M");
  });

  it("returns skipped on transcode failure (non-zero exit)", async () => {
    const { compressVideoIfOversize } = await loadHelper();
    execMock.mockResolvedValueOnce(1);
    const big = makeFile("walkthrough.mp4", 300 * 1024 * 1024, "video/mp4");
    const result = await compressVideoIfOversize(big, 250 * 1024 * 1024);
    expect("skipped" in result).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toMatch(/exit/i);
    }
  });

  it("returns skipped if compressed output still exceeds the cap", async () => {
    const { compressVideoIfOversize } = await loadHelper();
    // 300 MB output; cap is 250 MB.
    readFileMock.mockResolvedValueOnce(new Uint8Array(300 * 1024 * 1024));
    const big = makeFile("walkthrough.mp4", 400 * 1024 * 1024, "video/mp4");
    const result = await compressVideoIfOversize(big, 250 * 1024 * 1024);
    expect("skipped" in result).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toMatch(/exceeds cap/i);
    }
  });

  it("registers a progress listener and clamps fractions to [0, 1]", async () => {
    const { compressVideoIfOversize } = await loadHelper();
    const observed: number[] = [];
    type ProgressFn = (evt: { progress: number }) => void;
    const captured: { fn: ProgressFn | null } = { fn: null };
    // Capture the registered callback synchronously when ffmpeg.on is
    // called inside the helper. Driving the callback after the helper
    // resolves still exercises the clamp/forward path.
    onMock.mockImplementation((event: string, cb: ProgressFn) => {
      if (event === "progress") captured.fn = cb;
    });
    const big = makeFile("walkthrough.mp4", 300 * 1024 * 1024, "video/mp4");
    await compressVideoIfOversize(
      big,
      250 * 1024 * 1024,
      (frac) => observed.push(frac),
    );
    // The helper has finished but the `on` registration captured the
    // callback we forward through. Drive it now and assert clamping.
    expect(captured.fn).not.toBeNull();
    captured.fn?.({ progress: -0.5 });
    captured.fn?.({ progress: 0.5 });
    captured.fn?.({ progress: 2 });
    expect(observed).toEqual([0, 0.5, 1]);
  });
});
