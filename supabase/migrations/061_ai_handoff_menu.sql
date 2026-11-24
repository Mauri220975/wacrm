-- ============================================================
-- AI soft handoff with a button menu.
--
-- When the bot can't answer it alerts the advisor and sends the
-- customer three buttons: "Nueva consulta" / "Seguir esperando" /
-- "Pedir cotización". These columns track where the conversation is:
--
--   ai_handoff_stage
--     NULL      normal bot conversation
--     'menu'    buttons shown, waiting for the customer's choice
--               (free text still gets a couple of bot replies)
--     'waiting' customer chose to wait — bot stays quiet
--     'quote'   bot is collecting quote details for the advisor
--
--   ai_handoff_free_replies
--     bot replies to typed text while in 'menu'; at the limit the
--     menu is shown again.
--
-- Everything resets when the customer writes again after more than
-- 24 h of silence (a new conversation, same as WhatsApp's window).
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_stage text
    CHECK (ai_handoff_stage IN ('menu', 'waiting', 'quote')),
  ADD COLUMN IF NOT EXISTS ai_handoff_free_replies integer NOT NULL DEFAULT 0;
