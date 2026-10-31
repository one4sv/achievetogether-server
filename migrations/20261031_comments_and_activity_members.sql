-- Applied to AchieveTogether Supabase on 2026-10-31.
ALTER TABLE public.posts_comments
    ADD COLUMN IF NOT EXISTS parent_id bigint
    REFERENCES public.posts_comments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS posts_comments_parent_id_idx
    ON public.posts_comments(parent_id);

CREATE TABLE IF NOT EXISTS public.post_comment_likes (
    comment_id bigint NOT NULL REFERENCES public.posts_comments(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id)
);
ALTER TABLE public.post_comment_likes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.habit_members (
    habit_id bigint NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    invited_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (habit_id, user_id)
);
ALTER TABLE public.habit_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS habit_members_user_status_idx
    ON public.habit_members(user_id, status);
