---
name: security
description: Security rules for frontend and backend.
---
# Purpose
Prevent leaking secrets.
# Rules
- Never expose SUPABASE_SERVICE_ROLE_KEY, API_SECRET, PRIVATE_TOKEN in frontend code.
- Input validation required.
