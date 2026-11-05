import { useMemo } from "react";
import { mayorPortrait, type MayorLook } from "../lib/mayorModel";
import { useAvatarSeed, useAvatarUrl } from "../lib/avatar";

/**
 * The mayor's avatar (the user's profile picture): a DiceBear Notionists
 * portrait on a sunrise gradient, from the seed picked in Settings. Initials
 * show for the moment the drawings take to load.
 */
export function MayorAvatar({ fallback, size = 30, seed }: { fallback: string; size?: number; seed?: string }) {
  const current = useAvatarSeed();
  const url = useAvatarUrl(seed ?? current);
  return (
    <span className={url ? "mayor-badge avatar" : "mayor-badge"} style={size !== 30 ? { width: size, height: size } : undefined} aria-hidden>
      {url ? <img src={url} alt="" width={size} height={size} draggable={false} /> : fallback}
    </span>
  );
}

/** The mayor's 3D figure, as it walks in the city: a small portrait for Settings' picker. */
export function MayorFigure({ look, fallback, size = 30 }: { look: MayorLook; fallback: string; size?: number }) {
  const url = useMemo(() => mayorPortrait(look, size * 3), [look, size]);
  return (
    <span className={url ? "mayor-badge figure" : "mayor-badge"} style={size !== 30 ? { width: size, height: size } : undefined} aria-hidden>
      {url ? <img src={url} alt="" width={size} height={size} draggable={false} /> : fallback}
    </span>
  );
}
