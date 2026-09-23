-- Candidate only: add a caller credential to exactly the four existing
-- important-news-monitor jobs. This migration is NOT approved for production yet.
-- It preserves each job's schedule, request body, URL and WHERE gates by changing
-- only the existing JSON headers expression in cron.job.command.
--
-- Before a separately approved production apply:
--   1. Set the same random 32-byte base64url value as the Function secret
--      IMPORTANT_NEWS_CRON_SECRET and the Vault secret named below.
--   2. Keep verify_jwt=false for this Function; its handler validates this
--      dedicated header before loading service-role credentials or parsing mode.
-- No credential value is embedded in this file.

do $migration$
declare
  expected_job_names text[] := array[
    'important-news-fetch',
    'important-news-judgement',
    'important-news-generation',
    'important-news-publish-ready'
  ];
  configured_secret text;
  job record;
  patched_command text;
  matching_headers integer;
  updated_jobs integer := 0;
begin
  select decrypted_secret
    into configured_secret
  from vault.decrypted_secrets
  where name = 'important_news_monitor_cron_secret';

  if configured_secret is null
     or configured_secret !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then
    raise exception 'IMPORTANT_NEWS_MONITOR_CRON_SECRET_NOT_CONFIGURED';
  end if;

  if (select count(*) from cron.job where jobname = any(expected_job_names)) <> 4 then
    raise exception 'IMPORTANT_NEWS_MONITOR_EXPECTED_FOUR_CRON_JOBS';
  end if;

  for job in
    select jobid, jobname, command
    from cron.job
    where jobname = any(expected_job_names)
    order by jobname
  loop
    if job.command !~* 'important-news-monitor'
       or job.command ~* 'x-important-news-cron-secret' then
      raise exception 'IMPORTANT_NEWS_MONITOR_CRON_AUTH_HEADER_ALREADY_PRESENT';
    end if;

    select count(*)
      into matching_headers
    from regexp_matches(
      job.command,
      $$headers[[:space:]]*:=[[:space:]]*'[^']*'::jsonb$$,
      'gi'
    );

    if matching_headers <> 1 then
      raise exception 'IMPORTANT_NEWS_MONITOR_CRON_HEADER_SHAPE_UNEXPECTED: %', job.jobname;
    end if;

    patched_command := regexp_replace(
      job.command,
      $pattern$(headers[[:space:]]*:=[[:space:]]*'[^']*'::jsonb)$pattern$,
      $replacement$\1 || jsonb_build_object(
        'x-important-news-cron-secret',
        (select decrypted_secret
         from vault.decrypted_secrets
         where name = 'important_news_monitor_cron_secret')
      )$replacement$,
      'i'
    );

    if patched_command = job.command
       or patched_command !~* 'x-important-news-cron-secret'
       or patched_command !~* 'vault[.]decrypted_secrets' then
      raise exception 'IMPORTANT_NEWS_MONITOR_CRON_AUTH_PATCH_FAILED: %', job.jobname;
    end if;

    -- Do not pass schedule, active, username, database or any other job field:
    -- cron.alter_job changes only this job's command.
    perform cron.alter_job(job.jobid, command := patched_command);
    updated_jobs := updated_jobs + 1;
  end loop;

  if updated_jobs <> 4 then
    raise exception 'IMPORTANT_NEWS_MONITOR_CRON_AUTH_INCOMPLETE';
  end if;
end
$migration$;
