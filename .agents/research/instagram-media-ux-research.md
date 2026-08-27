# Instagram Media UX Research
## What was researched
Photo and video display, grids.
## Source
UI patterns.
## Date accessed
August 27, 2026
## Relevant observations
- 3x3 grid on profile.
- Images are cropped to squares in the grid, but preserve aspect ratio in feed.
- Multiple images in a post use a carousel indicator (dots).
## UI pattern
- Seamless grid with 1px or 2px spacing.
## UX reasoning
- Creates a visually appealing mosaic of a user's content.
## How the pattern could apply to Insta Fixer
- If monitoring a user's posts, display them in a 3-column grid to match the expected mental model.
## What should NOT be copied
- Forcing square crops if the exact full image needs to be analyzed for changes.
## Implementation implications
- CSS Grid: `grid-template-columns: repeat(3, 1fr)`.
