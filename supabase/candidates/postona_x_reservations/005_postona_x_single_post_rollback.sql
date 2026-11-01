-- Rollback of 005_postona_x_single_post.sql (F3 SOURCE CANDIDATE). Re-runnable. Roll the single-post Edge code back
-- first. The rows it created stay valid reservation rows: a claimed one is swept to 'uncertain' when its lease runs
-- out (never re-sent), a never-sent one is 'planned' past its expires_at and becomes 'expired'.
begin;
drop function if exists postona_x_resv.post_now_begin(text, uuid, text, text);
drop function if exists postona_x_resv.post_now_check(uuid, uuid);
drop function if exists postona_x_resv.post_now_finish(uuid, uuid, text, text, text);
drop function if exists postona_x_resv.post_now_get(uuid);
drop function if exists postona_x_resv.own_single_post(uuid, uuid);
drop function if exists postona_x_resv.single_post_fence(uuid, text);
commit;
