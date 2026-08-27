# Accessibility Guidelines
## Semantic HTML
- Use proper `<nav>`, `<main>`, `<article>`, `<section>`, and `<header>` tags.
## Color Independence
- Never use color alone to convey meaning. E.g., a "Disconnected" state should be red AND have a warning icon and text label.
## Keyboard Support
- All interactive elements must be focusable (`tabindex="0"` or native elements).
- Use clear `:focus-visible` outlines (e.g., 2px solid #0095F6).
## ARIA
- Use `aria-label` for icon buttons in navigation.
- Use `aria-live="polite"` for dynamic feed updates.
## Contrast
- Text must have a minimum contrast ratio of 4.5:1 against its background.
