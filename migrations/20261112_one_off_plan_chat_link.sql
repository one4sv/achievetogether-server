-- 2026-11-12: allow a one-off plan to be associated with a group conversation.
-- Group membership does not grant access to a private plan automatically:
-- each member must still accept a separate plan invitation.
ALTER TABLE public.one_off_plans
    ADD COLUMN IF NOT EXISTS chat_id bigint
    REFERENCES public.chats(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS one_off_plans_chat_id_idx
    ON public.one_off_plans(chat_id)
    WHERE chat_id IS NOT NULL;
