import { useState } from "react";
import { RATING_MAX, RATING_MIN } from "../lib/protocol";

interface StarRatingProps {
  /** Current value (1-5). 0 renders as empty. */
  value: number;
  /** When provided the stars are clickable; omit for a read-only display. */
  onChange?: (value: number) => void;
  /** Disable interaction (e.g. while a publish is in flight). */
  disabled?: boolean;
  size?: "sm" | "md";
}

/**
 * Five-star control. Read-only by default; interactive when `onChange` is set,
 * which is what the rating prompt on a finished operation uses.
 */
export function StarRating({ value, onChange, disabled, size = "md" }: StarRatingProps) {
  const [hover, setHover] = useState(0);
  const interactive = Boolean(onChange) && !disabled;
  const shown = hover || value;
  const stars: number[] = [];
  for (let s = RATING_MIN; s <= RATING_MAX; s++) stars.push(s);

  return (
    <span
      className="star-rating"
      data-size={size}
      role={interactive ? "radiogroup" : undefined}
      aria-label="Calificación"
    >
      {stars.map((s) => (
        <button
          key={s}
          type="button"
          className="star"
          data-filled={s <= shown}
          disabled={!interactive}
          aria-label={`${s} ${s === 1 ? "estrella" : "estrellas"}`}
          aria-checked={interactive ? value === s : undefined}
          role={interactive ? "radio" : undefined}
          onClick={() => onChange?.(s)}
          onMouseEnter={() => interactive && setHover(s)}
          onMouseLeave={() => interactive && setHover(0)}
          style={{
            background: "none",
            border: "none",
            cursor: interactive ? "pointer" : "default",
            padding: 0,
            color: s <= shown ? "#f59e0b" : "#d1d5db",
            fontSize: size === "sm" ? "0.95em" : "1.4em",
            lineHeight: 1,
          }}
        >
          ★
        </button>
      ))}
    </span>
  );
}
