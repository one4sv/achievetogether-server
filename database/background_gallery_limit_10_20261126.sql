ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_bg_gallery_max5,
    DROP CONSTRAINT IF EXISTS settings_bg_gallery_max6,
    ADD CONSTRAINT settings_bg_gallery_max10
        CHECK (jsonb_typeof(bg_gallery) = 'array' AND jsonb_array_length(bg_gallery) <= 10);
