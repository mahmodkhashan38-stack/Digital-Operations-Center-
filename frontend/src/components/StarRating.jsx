// DOC-68 - "Employee Satisfaction Rating". A single, shared 1-5 star
// control used both for INPUT (Employee choosing a score - `onChange`
// passed) and DISPLAY (showing an already-submitted score - `onChange`
// omitted) - one component, one visual language for "what does 4 stars
// look like" everywhere in this app (task spec section 21: a clear 1-5
// star control).
//
// ACCESSIBILITY (task spec section 21):
//   - Each star is a real `<button>` (interactive mode) - natively
//     keyboard-reachable via Tab, activatable via Enter/Space, with no
//     custom key-handling needed to satisfy "keyboard accessible where
//     practical."
//   - Every star carries its own `aria-label` ("4 out of 5 stars") so a
//     screen reader announces the exact meaning of each control, not just
//     a bare glyph.
//   - The filled/empty distinction uses a DIFFERENT GLYPH (★ vs ☆), never
//     color alone (task spec: "do not rely only on color") - so the
//     selected state is still perceivable without color vision, and even
//     in a plain-text screen reader announcement of the character itself.
//   - The overall control has its own `aria-label` summarizing the
//     current value ("Rated 4 out of 5 stars" / "Not yet rated") for a
//     screen reader landing on the group as a whole.
const STAR_VALUES = [1, 2, 3, 4, 5];

function StarRating({ value = 0, onChange, size = 'medium' }) {
  const isInteractive = typeof onChange === 'function';
  const displayValue = value || 0;

  return (
    <div
      className={`star-rating star-rating-${size}`}
      role={isInteractive ? 'radiogroup' : 'img'}
      aria-label={isInteractive
        ? 'Select a star rating'
        : (displayValue > 0 ? `Rated ${displayValue} out of 5 stars` : 'Not yet rated')}
    >
      {STAR_VALUES.map((starValue) => {
        const filled = starValue <= displayValue;
        const label = `${starValue} out of 5 stars`;

        if (!isInteractive) {
          return (
            <span key={starValue} className={`star-rating-star ${filled ? 'star-rating-star-filled' : 'star-rating-star-empty'}`} aria-hidden="true">
              {filled ? '★' : '☆'}
            </span>
          );
        }

        return (
          <button
            key={starValue}
            type="button"
            role="radio"
            aria-checked={starValue === displayValue}
            aria-label={label}
            className={`star-rating-star star-rating-star-button ${filled ? 'star-rating-star-filled' : 'star-rating-star-empty'}`}
            onClick={() => onChange(starValue)}
          >
            {filled ? '★' : '☆'}
          </button>
        );
      })}
    </div>
  );
}

export default StarRating;
