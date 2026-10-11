// The 銘柄 tab's load sequence as a pure, injectable function (no RN, no Supabase import: testable with Deno).
//
// Why it exists: the saved report's valuation may be paired with the registrations only while they are the
// registrations of THIS load. Every load (first open, tab focus, pull-to-refresh) therefore
//   1. makes valuations ineligible immediately -- `begin()` is the first thing that happens, before any await --
//      so the registrations/valuations of a previous load can never be shown as current while this one is pending;
//   2. applies results only if this is still the latest load (a slower, older load can neither overwrite newer data
//      nor re-open valuations while a newer load is pending);
//   3. reports `settled(true)` only after THIS load read the registrations successfully AND its report request has
//      finished, so the report and the registrations are paired as one generation. A failed / signed-out read
//      settles `false` and stays "unknown" -- it is never read as "no holdings".

/** Latest-wins ticket counter: starting a load makes every earlier load stale at once. */
export type LatestLoadGate = {
  begin(): number;
  isLatest(ticket: number): boolean;
};

export function createLatestLoadGate(): LatestLoadGate {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isLatest(ticket) {
      return ticket === latest;
    },
  };
}

export type RegistrationsResult<Registration> =
  | { status: 'ok'; items: Registration[] }
  | { status: 'signed_out' }
  | { status: 'failed' };

export type PortfolioLoadDeps<Registration, Reports> = {
  /** The signed-in user's own registrations; resolves to a status rather than throwing. A throw counts as 'failed'. */
  fetchRegistrations(): Promise<RegistrationsResult<Registration>>;
  /** The stored reports; rejects on failure. */
  fetchReports(): Promise<Reports>;
};

export type PortfolioLoadSink<Registration, Reports> = {
  /** First call of every load: valuations become ineligible, the loading state starts. */
  begin(): void;
  reports(next: Reports): void;
  reportsFailed(): void;
  registrations(result: RegistrationsResult<Registration>): void;
  /** Last call of a load that is still the latest. `ready` = the registrations were read and are paired with the reports. */
  settled(ready: boolean): void;
};

export async function runPortfolioLoad<Registration, Reports>(
  gate: LatestLoadGate,
  deps: PortfolioLoadDeps<Registration, Reports>,
  sink: PortfolioLoadSink<Registration, Reports>,
): Promise<void> {
  const ticket = gate.begin();
  sink.begin();

  const reportsDone = Promise.resolve()
    .then(() => deps.fetchReports())
    .then(
      (next) => {
        if (gate.isLatest(ticket)) sink.reports(next);
      },
      () => {
        if (gate.isLatest(ticket)) sink.reportsFailed();
      },
    );

  let result: RegistrationsResult<Registration>;
  try {
    result = await deps.fetchRegistrations();
  } catch {
    result = { status: 'failed' };
  }
  if (!gate.isLatest(ticket)) return;
  sink.registrations(result);

  await reportsDone;
  if (!gate.isLatest(ticket)) return;
  sink.settled(result.status === 'ok');
}
