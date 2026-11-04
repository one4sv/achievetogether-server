-- Six user backgrounds; preserve existing galleries and ownership.
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_bg_gallery_max5;
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_bg_gallery_max6;
ALTER TABLE public.settings
    ADD CONSTRAINT settings_bg_gallery_max6
    CHECK (jsonb_typeof(bg_gallery) = 'array' AND jsonb_array_length(bg_gallery) <= 6);
