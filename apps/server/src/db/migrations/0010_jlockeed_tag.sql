-- ============================================================================
-- Migration 0010: The Jlockeed tag
-- ============================================================================
-- Serves SPEC.md §5 (tags) and SPEC §11 R278, quoted:
--   R278: "'Jlockeed' is a tag (§5) on the two cards whose names make them
--   Jlockeed's, #13 Jlockeed Shredder-10 and #14 Jlockeed's Weapons, and on no
--   other".
--
-- Why this exists: 0002's `cards_tags_check` lists the tags BUILD M4-T1 named,
-- and 'Jlockeed' is not among them. `db:seed-catalog` copies every catalog
-- entry into public.cards in one transaction, so #13 and #14 broke that
-- constraint and the whole catalog failed to seed. This file puts the same
-- check back with 'Jlockeed' added and nothing else changed. The tag list
-- stays in the same order as the `Tag` union in packages/shared.
--
-- Nothing reads the tags at runtime: the API serves catalog.json itself, and
-- public.cards only gives the collection's foreign keys and L6 something to
-- point at (0002's comment on the table). No existing row is rewritten. Every
-- row 0002 admitted, this check admits too.
--
-- Apply order: 0002 (`public.cards`) -> ... -> 0009 -> 0010 (this file).
-- Safe to re-apply: drop-constraint-if-exists-then-add, as 0008 does.
-- ============================================================================

alter table public.cards drop constraint if exists cards_tags_check;
alter table public.cards add constraint cards_tags_check check (
  -- SPEC §5: the tags a card may carry. BUILD M4-T1 named the first seven and
  -- Token, and R278 added Jlockeed.
  tags <@ array[
    'Human', 'Felinor', 'KY', 'CN', 'Fruit', 'Call to Chaos', 'Quickdraw', 'Jlockeed', 'Token'
  ]::text[]
);

comment on constraint cards_tags_check on public.cards is
  $$SPEC §5 and R278: every tag is one of Human, Felinor, KY, CN, Fruit,
  'Call to Chaos', Quickdraw, Jlockeed, Token. First defined in 0002;
  0010 re-adds it with Jlockeed.$$;

-- ----------------------------------------------------------------------------
-- Grants: nothing changes. public.cards keeps 0002's grants and policies.
-- ============================================================================
