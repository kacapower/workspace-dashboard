# Instagram Product Research
## What was researched
Core Instagram product features, primarily focusing on mobile app interaction.
## Source
Official Meta Documentation, App Store/Play Store descriptions, design pattern articles (e.g. NNGroup, Mobbin).
## Date accessed
August 27, 2026
## Relevant observations
- **Navigation:** Bottom tab bar is the primary navigation (Home, Search, Create, Reels, Profile).
- **Core Entities:** Posts (Photos/Carousels/Videos), Stories (24h ephemeral), Reels (short-form vertical video), IGTV (deprecated/merged).
- **Interactions:** Double-tap to like, swipe horizontally between feed and camera/DMs, tap right/left on stories to skip.
## UI pattern
- Content-first approach: Minimalist framing (mostly white or black depending on dark mode) to make photos/videos stand out.
- Circular avatars for stories, with colorful gradient rings indicating unwatched stories.
## UX reasoning
- Engagement: Infinite scrolling in feed and Reels maximizes time spent.
- Urgency: Ephemeral stories drive daily active usage.
## How the pattern could apply to Insta Fixer
- Insta Fixer could use a feed-like timeline to display profile changes or monitored activity.
- The gradient ring could indicate a recently changed profile.
## What should NOT be copied
- The algorithm-driven infinite scroll. Insta Fixer is a utility for monitoring, so chronological and deterministic ordering is better.
## Implementation implications
- Need smooth scrolling and touch-friendly targets.
