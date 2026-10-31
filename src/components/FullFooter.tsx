import { useEffect, useMemo, useRef, useState } from "react";
import { cityStats, type City } from "../lib/city";
import type { UpdateStatus } from "../lib/types";
import { VersionDot } from "./VersionDot";

/**
 * Full screen's footer, kept slim: the model reading captures on the left,
 * a small skyline of your city in the middle (it glows when someone moves
 * in), and on the right an "Update ready" pill only when a new version is
 * downloaded.
 */
export function FullFooter({
  model,
  onModel,
  city,
  showCity,
  onCity,
  now,
  version,
  update,
  onError,
}: {
  model: string | null;
  onModel: () => void;
  city: City;
  showCity: boolean;
  onCity: () => void;
  now: Date;
  version: string | null;
  update: UpdateStatus;
  onError: (message: string) => void;
}) {
  const stats = useMemo(() => cityStats(city, "week", now), [city, now]);
  // The tallest few buildings, as a tiny skyline: lit from the ground up as their homes fill.
  const skyline = useMemo(() => {
    const real = city.buildings.filter((b) => b.kind !== "plots");
    const sized = real
      .map((b) => {
        const rooms = b.floors.reduce((n, f) => n + f.rooms.length, 0);
        const lit = b.floors.reduce((n, f) => n + f.rooms.filter((r) => r.lit).length, 0);
        return { key: b.key, rooms, lit };
      })
      .sort((a, b) => b.rooms - a.rooms)
      .slice(0, 9);
    const max = Math.max(1, ...sized.map((s) => s.rooms));
    // Tallest in the middle, like a downtown.
    const order: typeof sized = [];
    sized.forEach((s, i) => (i % 2 ? order.push(s) : order.unshift(s)));
    return order.map((s) => ({ key: s.key, h: 6 + Math.round((12 * s.rooms) / max), lit: s.rooms ? s.lit / s.rooms : 0 }));
  }, [city]);
  // A soft glow when a window lights up while you watch.
  const [pulse, setPulse] = useState(false);
  const last = useRef(city.total);
  useEffect(() => {
    if (last.current > 0 && city.total > last.current) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 1400);
      last.current = city.total;
      return () => window.clearTimeout(t);
    }
    last.current = city.total;
  }, [city.total]);

  return (
    <footer className="full-foot" aria-label="Status">
      <div className="ff-left">
        <button type="button" className="ff-model" onClick={onModel} title="Settings → Open models">
          <span className="local-dot" aria-hidden />
          <span>On this Mac · {model ?? "Add AI model"}</span>
        </button>
      </div>
      {showCity ? (
        <button type="button" className={pulse ? "ff-city lit-up" : "ff-city"} onClick={onCity} title="Every task you finish moves a resident into your city. Click to look around.">
          <span className="ff-sky" aria-hidden>
            {skyline.map((b) => (
              <span key={b.key} className="ff-tower" style={{ height: b.h }}>
                <span className="ff-lit" style={{ height: `${Math.round(b.lit * 100)}%` }} />
              </span>
            ))}
          </span>
          <span>
            <b className="ff-strong">{city.total}</b> {city.total === 1 ? "resident" : "residents"}
          </span>
          {stats.today > 0 && <span className="ff-today">+{stats.today} today</span>}
        </button>
      ) : (
        <span />
      )}
      <div className="ff-right">
        <VersionDot update={update} version={version} onError={onError} />
      </div>
    </footer>
  );
}
