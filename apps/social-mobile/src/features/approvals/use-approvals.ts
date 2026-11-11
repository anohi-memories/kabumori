import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { parseJstInput } from '@/features/reservations/reservation-view';
import type { ApprovalAnswer, Candidate } from './approval-client';
import { actionOf, ACTION_TEXT, APPROVED_TEXT, type ApprovalAction, type ApprovalBlock, HASH_MISMATCH_TEXT, REJECTED_TEXT, REREAD_FAILED_TEXT, rereads, REVISED_TEXT, SUBMIT_CONFIRMED_TEXT, SUBMIT_PENDING_TEXT, SUBMITTED_TEXT } from './approval-view';
import { useApprovalEnv } from './use-approval-env';

export type ApprovalNotice = { tone: 'success' | 'warning' | 'danger'; text: string };
export type CandidateList = { state: 'loading' } | { state: 'ready'; items: Candidate[] } | { state: 'error'; action: ApprovalAction };
/** One "承認に回す": its request id is kept until the server answers for sure, so a retry is the same candidate (contract §3). */
type PendingSubmit = { clientRequestId: string; body: string; scheduledAt: string };
type Box = { scope: string; list: CandidateList; busy: string | null; notice: ApprovalNotice | null; pending: PendingSubmit | null; generationChanged: string[] };

export type ApprovalsView =
  | { kind: 'blocked'; block: ApprovalBlock }
  | {
      kind: 'open';
      list: CandidateList;
      busy: string | null;
      notice: ApprovalNotice | null;
      /** Candidates the server refused to approve for an earlier connection generation: revise them under the current one first. */
      generationChanged: string[];
      submit: (body: string, timeText: string) => Promise<boolean>;
      revise: (candidate: Candidate, body: string, timeText: string) => Promise<boolean>;
      approve: (candidate: Candidate) => void;
      reject: (candidate: Candidate) => void;
      reload: () => void;
    };

const fresh = (scope: string, list: CandidateList = { state: 'loading' }, notice: ApprovalNotice | null = null): Box => ({ scope, list, busy: null, notice, pending: null, generationChanged: [] });
const upsert = (list: CandidateList, row: Candidate): CandidateList => (list.state === 'ready'
  ? { state: 'ready', items: [row, ...list.items.filter((item) => item.candidateId !== row.candidateId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  : list);
const without = (list: CandidateList, id: string): CandidateList => (list.state === 'ready' ? { state: 'ready', items: list.items.filter((item) => item.candidateId !== id) } : list);
const sha256 = (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
const sameTime = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
/**
 * A list that answered (G1 TASK 45, G2 #9 A18): an older warning goes with it, except the 「承認に回す」 whose answer was lost -- the
 * list then says whether it was made (the same text and time, pending), or the press-again words stay.
 */
function listed(current: Box, items: Candidate[]): Box {
  const list: CandidateList = { state: 'ready', items };
  const pending = current.pending;
  if (pending) {
    const made = items.some((c) => c.state === 'pending_approval' && c.body === pending.body && sameTime(c.scheduledAt, pending.scheduledAt));
    return made ? { ...current, list, pending: null, notice: { tone: 'success', text: SUBMIT_CONFIRMED_TEXT } } : { ...current, list };
  }
  return { ...current, list, notice: current.notice?.tone === 'success' ? current.notice : null };
}

/**
 * The selected X account's post candidates (G3 contract §7). Nothing becomes a reservation before 「承認」; the shown revision and the hash
 * of the shown text are what is approved, and the app checks that hash itself first. A conflict or an answer it cannot trust is read
 * back (`get`) before anything is said; a refusal of the person's access drops everything held.
 */
export function useApprovals(): ApprovalsView {
  const env = useApprovalEnv();
  const [box, setBox] = useState<Box | null>(null);
  const [reads, setReads] = useState(0);
  const live = useRef<string | null>(null);
  const { scope, client, accountId } = env;

  if (scope === null ? box !== null : box?.scope !== scope) setBox(scope === null ? null : fresh(scope));
  const update = (mine: string, change: (current: Box) => Box) => setBox((current) => (current && current.scope === mine ? change(current) : current));
  const dropAll = (mine: string, action: ApprovalAction) => setBox((current) => (current && current.scope === mine ? fresh(mine, { state: 'error', action }, { tone: 'danger', text: ACTION_TEXT[action] }) : current));

  useEffect(() => {
    live.current = scope;
    if (scope === null || !client || !accountId) return;
    const mine = scope;
    let cancelled = false;
    void client.list(accountId).then((answer) => {
      if (cancelled || live.current !== mine) return;
      if (answer.ok) { update(mine, (current) => listed(current, answer.value)); return; }
      const action = actionOf(answer.code, answer.definite);
      if (action === 'sign_in' || action === 'forbidden') dropAll(mine, action);
      else update(mine, (current) => ({ ...current, list: { state: 'error', action } }));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, env.refocus, reads]);

  if (scope === null || !client || !accountId) return { kind: 'blocked', block: env.block ?? 'workspace_unavailable' };
  const mine = scope;
  const shown = box && box.scope === mine ? box : null;
  const markGeneration = (id: string, on: boolean) => update(mine, (current) => ({ ...current, generationChanged: on ? [...current.generationChanged.filter((x) => x !== id), id] : current.generationChanged.filter((x) => x !== id) }));

  /** A refusal or an unknown outcome for one candidate: read it back first, then say what the answer asks for. */
  const settle = async (candidate: Candidate, answer: Extract<ApprovalAnswer<unknown>, { ok: false }>) => {
    const action = actionOf(answer.code, answer.definite);
    if (action === 'sign_in' || action === 'forbidden') { dropAll(mine, action); return; }
    if (action === 'generation_changed') markGeneration(candidate.candidateId, true);
    if (action === 'not_found') {
      update(mine, (current) => ({ ...current, busy: null, list: without(current.list, candidate.candidateId), notice: { tone: 'warning', text: ACTION_TEXT.not_found } }));
      return;
    }
    // The words say what the read back did (G1 TASK 45, G2 #9 A17): read, or could not be read.
    let readBack: 'none' | 'ok' | 'failed' = 'none';
    if (rereads(action)) {
      const back = await client.get(candidate.candidateId);
      if (live.current !== mine) return;
      const backAction = back.ok ? null : actionOf(back.code, back.definite);
      if (back.ok) { readBack = 'ok'; update(mine, (current) => ({ ...current, list: upsert(current.list, back.value) })); }
      else if (backAction === 'not_found') { readBack = 'ok'; update(mine, (current) => ({ ...current, list: without(current.list, candidate.candidateId) })); }
      else if (backAction === 'sign_in' || backAction === 'forbidden') { dropAll(mine, backAction); return; }
      else readBack = 'failed';
    }
    const text = readBack === 'failed' ? REREAD_FAILED_TEXT : ACTION_TEXT[action];
    update(mine, (current) => ({ ...current, busy: null, notice: { tone: action === 'uncertain' || action === 'later' || readBack === 'failed' ? 'warning' : 'danger', text } }));
  };

  const decided = (row: Candidate, text: string) => update(mine, (current) => ({ ...current, busy: null, list: upsert(current.list, row), notice: { tone: 'success', text } }));

  const submit = async (body: string, timeText: string) => {
    if (!shown || shown.busy) return false;
    const parsed = parseJstInput(timeText, new Date());
    if (!parsed.ok) { update(mine, (current) => ({ ...current, notice: { tone: 'danger', text: parsed.message } })); return false; }
    const same = shown.pending && shown.pending.body === body && shown.pending.scheduledAt === parsed.iso ? shown.pending : null;
    const pending: PendingSubmit = same ?? { clientRequestId: Crypto.randomUUID(), body, scheduledAt: parsed.iso };
    update(mine, (current) => ({ ...current, busy: 'submit', pending, notice: null }));
    const answer = await client.submit({ socialAccountId: accountId, clientRequestId: pending.clientRequestId, body, scheduledAt: parsed.iso });
    if (live.current !== mine) return false;
    if (answer.ok) {
      update(mine, (current) => ({ ...current, busy: null, pending: null, list: upsert(current.list, answer.value), notice: { tone: 'success', text: SUBMITTED_TEXT } }));
      return true;
    }
    const action = actionOf(answer.code, answer.definite);
    if (action === 'sign_in' || action === 'forbidden') { dropAll(mine, action); return false; }
    if (action === 'uncertain' || action === 'later') {
      // It may exist: the list says, and the kept request id makes the next press the same candidate.
      update(mine, (current) => ({ ...current, busy: null, notice: { tone: 'warning', text: SUBMIT_PENDING_TEXT } }));
      setReads((value) => value + 1);
      return false;
    }
    update(mine, (current) => ({ ...current, busy: null, pending: null, notice: { tone: 'danger', text: ACTION_TEXT[action] } }));
    return false;
  };

  const revise = async (candidate: Candidate, body: string, timeText: string) => {
    if (!shown || shown.busy) return false;
    const parsed = parseJstInput(timeText, new Date());
    if (!parsed.ok) { update(mine, (current) => ({ ...current, notice: { tone: 'danger', text: parsed.message } })); return false; }
    update(mine, (current) => ({ ...current, busy: candidate.candidateId, notice: null }));
    const answer = await client.revise({ candidateId: candidate.candidateId, expectedRevision: candidate.revision, body, scheduledAt: parsed.iso });
    if (live.current !== mine) return false;
    if (answer.ok) { markGeneration(candidate.candidateId, false); decided(answer.value, REVISED_TEXT); return true; }
    await settle(candidate, answer);
    return false;
  };

  const approve = (candidate: Candidate) => {
    if (!shown || shown.busy || candidate.state !== 'pending_approval') return;
    update(mine, (current) => ({ ...current, busy: candidate.candidateId, notice: null }));
    void (async () => {
      // The hash approved is the hash of the text on the screen: if the shown text is not what the server hashed, nothing is sent.
      if ((await sha256(candidate.body)) !== candidate.contentSha256) {
        if (live.current !== mine) return;
        update(mine, (current) => ({ ...current, busy: null, notice: { tone: 'danger', text: HASH_MISMATCH_TEXT } }));
        return;
      }
      const answer = await client.approve({ candidateId: candidate.candidateId, expectedRevision: candidate.revision, contentSha256: candidate.contentSha256 });
      if (live.current !== mine) return;
      if (answer.ok) { decided(answer.value, APPROVED_TEXT); return; }
      await settle(candidate, answer);
    })();
  };

  const reject = (candidate: Candidate) => {
    if (!shown || shown.busy || candidate.state !== 'pending_approval') return;
    update(mine, (current) => ({ ...current, busy: candidate.candidateId, notice: null }));
    void client.reject({ candidateId: candidate.candidateId, expectedRevision: candidate.revision }).then(async (answer) => {
      if (live.current !== mine) return;
      if (answer.ok) { markGeneration(candidate.candidateId, false); decided(answer.value, REJECTED_TEXT); return; }
      await settle(candidate, answer);
    });
  };

  return {
    kind: 'open',
    list: shown?.list ?? { state: 'loading' },
    busy: shown?.busy ?? null,
    notice: shown?.notice ?? null,
    generationChanged: shown?.generationChanged ?? [],
    submit,
    revise,
    approve,
    reject,
    reload: () => setReads((value) => value + 1),
  };
}
