-- Restore the five-image user wallpaper limit without altering existing gallery data.
-- Existing galleries were inspected on 2026-11-06: none exceed five items.
ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_bg_gallery_max6;

ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_bg_gallery_max5;

ALTER TABLE public.settings
    ADD CONSTRAINT settings_bg_gallery_max5
    CHECK (jsonb_typeof(bg_gallery) = 'array' AND jsonb_array_length(bg_gallery) <= 5);
