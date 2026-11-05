import { describe, expect, it } from "vitest";
import parity from "../vendor/dicebear/parity.json";
import { DEFAULT_SEED, avatarSvg, loadAvatars, newSeed, seedOr } from "./avatar";

describe("avatars", () => {
  it("draws exactly what DiceBear draws", async () => {
    const { core, style } = await loadAvatars();
    for (const c of parity as { id: string; options: Record<string, unknown>; svg: string }[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(new core.Avatar(style, c.options as any).toString(), c.id).toBe(c.svg);
    }
  });
  it("draws on the Sunrise background, the same for the same seed", async () => {
    const { core, style } = await loadAvatars();
    const a = avatarSvg(core, style, "maya");
    expect(a).toBe(avatarSvg(core, style, "maya"));
    expect(a).not.toBe(avatarSvg(core, style, "dana"));
    expect(a.toLowerCase()).toContain("ffd9b0");
    expect(a.toLowerCase()).toContain("ffa8bf");
    expect(a).toMatch(/linearGradient/);
  });
  it("makes new seeds and has a default", () => {
    const a = newSeed();
    expect(a).toMatch(/^[a-z0-9]{6,10}$/);
    expect(newSeed()).not.toBe(a);
    expect(seedOr("")).toBe(DEFAULT_SEED);
    expect(seedOr("  sam ")).toBe("sam");
  });
});
