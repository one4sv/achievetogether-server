ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS bg_gallery jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS bg_effects jsonb NOT NULL DEFAULT '{"blur":0,"movement":false,"filter":"none"}'::jsonb;

UPDATE public.settings SET bg_gallery = jsonb_build_array(jsonb_build_object('url', bg_url, 'path', null))
WHERE bg_url IS NOT NULL AND bg_url <> '' AND bg_gallery = '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_bg_gallery_max5') THEN
        ALTER TABLE public.settings ADD CONSTRAINT settings_bg_gallery_max5
        CHECK (jsonb_typeof(bg_gallery) = 'array' AND jsonb_array_length(bg_gallery) <= 5);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_bg_effects_is_object') THEN
        ALTER TABLE public.settings ADD CONSTRAINT settings_bg_effects_is_object
        CHECK (jsonb_typeof(bg_effects) = 'object');
    END IF;
END $$;
