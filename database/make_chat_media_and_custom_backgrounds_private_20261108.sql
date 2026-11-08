-- Applied on 2026-11-08 to AchieveTogether's Supabase project.
-- Historical public storage paths remain in DB for exact metadata matching.
-- The API rewrites them to /api/private-asset/* and authenticates every download.
-- Custom backgrounds from older accounts are resolved by owner-prefixed paths.
-- Never restore public access as a workaround for missing client permissions.

update storage.buckets
set public = false
where id in ('media', 'bgs') and public = true;
